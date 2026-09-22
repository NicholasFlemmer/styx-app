import { fixtures, type ProjectId, type SessionId } from '@styx/core';
import { parsePatch } from '../../features/diff';
import { describe, expect, it } from 'vitest';
import {
  defaultLane,
  landLabelOf,
  laneDiffHeader,
  laneRows,
  mergedWhen,
  nextWorktreeBranch,
  publishLabelOf,
  remoteLabel,
  remoteLine,
  repoOfProject,
} from './repo-data';

const acme = fixtures.ids.project.acmeShop as ProjectId;
const NOW = fixtures.DEMO_NOW;

describe('Repo lanes (prototype `lanes`)', () => {
  const model = fixtures.demoReadModel();
  const lanes = laneRows(model, acme, NOW);

  it.each([
    ['main', 'you', 'text', 'clean · ↑0 ↓2', '—', 'Open'],
    ['fix/checkout', 'Claude', 'text', '+142 −38 · 3 files', '#214 draft', 'Diff'],
    ['test/flaky', 'Codex', 'accent', 'waiting on grant', '—', 'Diff'],
    ['feat/promo', 'Cursor', 'line', 'merged yesterday', '#212 ✓', 'Archive'],
  ])('%s → %s · %s · %s · %s · %s', (branch, owner, dot, changes, pr, action) => {
    const lane = lanes.find((l) => l.branch === branch);
    expect(lane).toMatchObject({ owner, dot, changes, pr, actionLabel: action });
  });

  it.each([
    ['main', 'Commit & push', null],
    ['fix/checkout', 'Commit & push', 'https://github.com/acme/shop/pull/214'],
    ['test/flaky', 'Open PR', null],
    ['feat/promo', null, 'https://github.com/acme/shop/pull/212'],
  ])('%s publishes as %s; PR link %s', (branch, publishLabel, prUrl) => {
    expect(lanes.find((l) => l.branch === branch)).toMatchObject({ publishLabel, prUrl });
  });

  it('a lane behind its base carries `sync` (↓N main → Bring in main); main, merged and conflicting lanes do not', () => {
    const m = fixtures.demoReadModel();
    const behind = {
      ...m.worktrees.byId,
      [fixtures.ids.worktree.fixCheckout]: {
        ...m.worktrees.byId[fixtures.ids.worktree.fixCheckout]!,
        behindBase: 3,
      },
      [fixtures.ids.worktree.acmeMain]: {
        ...m.worktrees.byId[fixtures.ids.worktree.acmeMain]!,
        behindBase: 2,
      },
      [fixtures.ids.worktree.featPromo]: {
        ...m.worktrees.byId[fixtures.ids.worktree.featPromo]!,
        behindBase: 4,
      },
    };
    const rows = laneRows({ ...m, worktrees: { ...m.worktrees, byId: behind } }, acme, NOW);
    expect(rows.find((l) => l.branch === 'fix/checkout')?.sync).toEqual({
      n: 3,
      base: 'main',
      label: 'Bring in main',
    });
    expect(rows.find((l) => l.branch === 'main')?.sync).toBeNull();
    expect(rows.find((l) => l.branch === 'feat/promo')?.sync).toBeNull(); // merged
    expect(lanes.every((l) => l.sync === null)).toBe(true); // the fixture's lanes are current
  });

  it('publishLabelOf: a merged or closed PR gets a new one; conflict, merged and branchless lanes offer nothing', () => {
    const base = { branch: 'x', isMain: false, conflict: null, mergedAt: null };
    expect(publishLabelOf({ ...base, pr: { number: 1, state: 'merged', url: null } })).toBe('Open PR');
    expect(publishLabelOf({ ...base, pr: { number: 1, state: 'closed', url: null } })).toBe('Open PR');
    expect(publishLabelOf({ ...base, pr: { number: 1, state: 'open', url: null } })).toBe('Commit & push');
    expect(publishLabelOf({ ...base, pr: null, conflict: { file: 'a', against: 'main' } })).toBeNull();
    expect(publishLabelOf({ ...base, pr: null, mergedAt: 1 })).toBeNull();
    expect(publishLabelOf({ ...base, pr: null, branch: null })).toBeNull();
  });

  it('lists every non-archived worktree of the project: main first, merged last', () => {
    expect(lanes[0]?.isMain).toBe(true);
    expect(lanes.map((l) => l.branch)).toEqual(['main', 'fix/checkout', 'test/flaky', 'feat/promo']);
  });

  it('error fixture: the conflicting lane reads CONFLICT and its action becomes Resolve, dot unchanged', () => {
    const conflict = laneRows(fixtures.errorReadModel(), acme, NOW).find((l) => l.branch === 'fix/checkout');
    expect(conflict).toMatchObject({
      changes: 'CONFLICT · checkout.ts vs main',
      actionLabel: 'Resolve',
      action: 'resolve',
      dot: 'text',
      conflict: { file: 'checkout.ts', against: 'main' },
    });
  });

  it('selects the active session lane, else the first agent lane with a diff', () => {
    expect(defaultLane(lanes, null)?.branch).toBe('fix/checkout');
    expect(defaultLane(lanes, fixtures.ids.session.codex as SessionId)?.branch).toBe('test/flaky');
    expect(defaultLane([], null)).toBeNull();
  });

  it('header line reads `github.com/acme/shop · main ↑0 ↓2`', () => {
    expect(remoteLine(repoOfProject(model, acme))).toBe('github.com/acme/shop · main ↑0 ↓2');
    expect(remoteLabel({ remotes: [{ name: 'origin', url: 'git@github.com:acme/shop.git' }] })).toBe(
      'github.com/acme/shop',
    );
    expect(remoteLabel(null)).toBe('—');
  });

  it('lane diff header: branch · file · +added −removed', () => {
    expect(laneDiffHeader('fix/checkout', parsePatch(fixtures.demoLaneDiff))).toBe(
      'fix/checkout · checkout.ts · +3 −0',
    );
    expect(laneDiffHeader('x', { files: [] })).toBe('x');
  });

  it.each([
    [0, 'today'],
    [1, 'yesterday'],
    [3, '3d ago'],
  ])('mergedWhen %i days ago → %s', (days, expected) => {
    expect(mergedWhen(NOW - days * 86_400_000, NOW)).toBe(expected);
  });

  it('next user worktree branch skips taken names', () => {
    expect(nextWorktreeBranch(model, acme)).toBe('wt-1');
  });
});

describe('lane overlaps (ADR-0025)', () => {
  it('a lane that shares files with another live lane names its branch and files; merged lanes never do', () => {
    const model = fixtures.demoReadModel();
    const w = model.worktrees.byId[fixtures.ids.worktree.fixCheckout];
    const merged = model.worktrees.byId[fixtures.ids.worktree.featPromo];
    if (w === undefined || merged === undefined) throw new Error('fixture');
    const overlap = [{ worktreeId: fixtures.ids.worktree.testFlaky, files: ['src/checkout.ts'] }];
    const withOverlaps = {
      ...model,
      worktrees: {
        ...model.worktrees,
        byId: {
          ...model.worktrees.byId,
          [w.id]: { ...w, overlaps: overlap },
          [merged.id]: { ...merged, overlaps: overlap },
        },
      },
    };
    const lanes = laneRows(withOverlaps, acme, NOW);
    expect(lanes.find((l) => l.branch === 'fix/checkout')?.overlaps).toEqual({
      branches: ['test/flaky'],
      files: ['src/checkout.ts'],
    });
    expect(lanes.find((l) => l.branch === 'feat/promo')?.overlaps).toBeNull();
    expect(laneRows(model, acme, NOW).every((l) => l.overlaps === null)).toBe(true);
  });
});

describe('landing (ADR-0025 phase C)', () => {
  const model = fixtures.demoReadModel();
  const lanes = laneRows(model, acme, NOW);

  it('auto mode (the default): live lanes on a branch offer Land; main and merged lanes do not', () => {
    expect(lanes.map((l) => [l.branch, l.landLabel])).toEqual([
      ['main', null],
      ['fix/checkout', 'Land'],
      ['test/flaky', 'Land'],
      ['feat/promo', null],
    ]);
  });

  it('landLabelOf: review mode says Merge into {base}; a conflict, a merge in progress or no branch offers nothing', () => {
    const base = { branch: 'x', isMain: false, conflict: null, mergedAt: null, resolution: null };
    expect(landLabelOf(base, 'review', 'main')).toBe('Merge into main');
    expect(landLabelOf(base, 'auto', 'main')).toBe('Land');
    expect(landLabelOf({ ...base, conflict: { file: 'a', against: 'main' } }, 'auto', 'main')).toBeNull();
    expect(landLabelOf({ ...base, branch: null }, 'auto', 'main')).toBeNull();
    expect(landLabelOf({ ...base, isMain: true }, 'auto', 'main')).toBeNull();
    expect(landLabelOf({ ...base, mergedAt: 1 }, 'auto', 'main')).toBeNull();
    const resolving = {
      state: 'resolving' as const,
      sessionId: null,
      files: [],
      preHead: 'p',
      preTree: null,
      mergeCommit: null,
      attempts: 1,
      startedAt: NOW,
      finishedAt: null,
      failure: null,
    };
    expect(landLabelOf({ ...base, resolution: resolving }, 'auto', 'main')).toBeNull();
  });

  it('a landed lane reads `landed …` and offers Undo landing while the landing is the base HEAD, Archive after', () => {
    const m = fixtures.demoReadModel();
    const lane = m.worktrees.byId[fixtures.ids.worktree.fixCheckout];
    const main = m.worktrees.byId[fixtures.ids.worktree.acmeMain];
    if (lane === undefined || main === undefined) throw new Error('fixture');
    const landing = {
      commit: 'landed1',
      base: 'main',
      pushed: true,
      at: NOW - 60_000,
      undoneAt: null,
      revertCommit: null,
    };
    const withMainAt = (head: string, undoneAt: number | null = null) =>
      laneRows(
        {
          ...m,
          worktrees: {
            ...m.worktrees,
            byId: {
              ...m.worktrees.byId,
              [lane.id]: { ...lane, mergedAt: NOW - 60_000, landing: { ...landing, undoneAt } },
              [main.id]: { ...main, headCommit: head },
            },
          },
        },
        acme,
        NOW,
      ).find((l) => l.branch === 'fix/checkout');
    expect(withMainAt('landed1')).toMatchObject({
      changes: 'landed today',
      action: 'undo-land',
      actionLabel: 'Undo landing',
      landLabel: null,
      publishLabel: null,
    });
    expect(withMainAt('later')).toMatchObject({ changes: 'landed today', action: 'archive' });
    // Undone: an ordinary merged row again (mergedAt is cleared by the command; here only the landing says so).
    expect(withMainAt('landed1', NOW)).toMatchObject({ changes: 'merged today', action: 'archive' });
  });
});

describe('lane resolution states (ADR-0025 phase B)', () => {
  const base = (
    state: 'resolving' | 'checking' | 'done' | 'failed',
    extra: Record<string, unknown> = {},
  ) => ({
    state,
    sessionId: fixtures.ids.session.claude,
    files: ['src/a.ts', 'src/b.ts'],
    preHead: 'pre',
    preTree: null,
    mergeCommit: null,
    attempts: 1,
    startedAt: NOW,
    finishedAt: null,
    failure: null,
    ...extra,
  });
  const withResolution = (resolution: ReturnType<typeof base>, patch: Record<string, unknown> = {}) => {
    const model = fixtures.demoReadModel();
    const w = model.worktrees.byId[fixtures.ids.worktree.fixCheckout];
    if (w === undefined) throw new Error('fixture');
    return {
      ...model,
      worktrees: {
        ...model.worktrees,
        byId: { ...model.worktrees.byId, [w.id]: { ...w, resolution, ...patch } },
      },
    };
  };
  const row = (model: ReturnType<typeof withResolution>) =>
    laneRows(model, acme, NOW).find((l) => l.branch === 'fix/checkout');

  it('resolving / checking read as such and offer nothing to click but the diff', () => {
    expect(row(withResolution(base('resolving')))).toMatchObject({
      changes: 'merging main with Claude…',
      action: 'diff',
    });
    expect(row(withResolution(base('checking')))).toMatchObject({
      changes: 'checking the merge…',
      action: 'diff',
    });
  });

  it('done on the current HEAD offers Undo merge; failed shows the conflict and Resolve again', () => {
    const done = withResolution(base('done', { mergeCommit: 'mc' }), { headCommit: 'mc', conflict: null });
    expect(row(done)).toMatchObject({
      changes: 'brought in main · 2 resolved',
      action: 'undo-merge',
      actionLabel: 'Undo merge',
    });
    // The lane moved on since: the ordinary row comes back.
    const moved = withResolution(base('done', { mergeCommit: 'mc' }), {
      headCommit: 'later',
      conflict: null,
    });
    expect(row(moved)?.action).not.toBe('undo-merge');
    const failed = withResolution(base('failed', { failure: 'markers' }), {
      conflict: { file: 'src/a.ts', against: 'main' },
    });
    expect(row(failed)).toMatchObject({ changes: 'CONFLICT · src/a.ts vs main', action: 'resolve' });
  });
});

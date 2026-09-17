import { fixtures, type ProjectId, type SessionId } from '@styx/core';
import { parsePatch } from '../../features/diff';
import { describe, expect, it } from 'vitest';
import {
  defaultLane,
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

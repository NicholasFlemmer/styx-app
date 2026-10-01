import { describe, expect, it } from 'vitest';
import { DEMO_NOW, demoReadModel, ids } from '../fixtures/demo';
import type { ReadModel } from '../read-model';
import type { Session } from '../model/session';
import type { Worktree } from '../model/project';
import {
  DEFAULT_HOTSPOTS,
  TASK_MAX,
  activeLanes,
  activeLanesLabel,
  globToRegExp,
  isHotspot,
  laneLine,
  laneOverlapSummary,
  navLanes,
  navLanesLabel,
  taskOf,
} from './lanes';

describe('taskOf', () => {
  it('is the first non-empty line of the first message, cut at TASK_MAX; else the note; else empty', () => {
    expect(taskOf({ firstMessage: '\n\n  Fix the checkout total  \nand more', note: 'ignored' })).toBe(
      'Fix the checkout total',
    );
    expect(taskOf({ firstMessage: null, note: 'Reading checkout.ts' })).toBe('Reading checkout.ts');
    expect(taskOf({ firstMessage: '   ', note: null })).toBe('');
    const long = 'x'.repeat(TASK_MAX + 20);
    const cut = taskOf({ firstMessage: long, note: null });
    expect(cut.length).toBe(TASK_MAX);
    expect(cut.endsWith('…')).toBe(true);
  });
});

describe('activeLanes', () => {
  const model = demoReadModel();
  it('lists live agent sessions on non-main lanes, in spawn order, and drops the caller with `except`', () => {
    const lanes = activeLanes(model, ids.project.acmeShop);
    expect(lanes.length).toBeGreaterThan(0);
    for (const lane of lanes) {
      const s = model.sessions.byId[lane.sessionId];
      const w = model.worktrees.byId[lane.worktreeId];
      expect(s?.state).not.toBe('done');
      expect(s?.purpose).toBeUndefined();
      expect(w?.isMain).toBe(false);
      expect(lane.branch).toBe(w?.branch);
    }
    const started = lanes.map((l) => model.sessions.byId[l.sessionId]?.startedAt ?? 0);
    expect([...started].sort((a, b) => a - b)).toEqual(started);
    const first = lanes[0];
    if (first === undefined) throw new Error('fixture');
    expect(activeLanes(model, ids.project.acmeShop, first.worktreeId).map((l) => l.worktreeId)).not.toContain(
      first.worktreeId,
    );
    // The done Cursor session's lane is not active.
    expect(lanes.map((l) => l.sessionId)).not.toContain(ids.session.cursor);
  });

  it('laneLine / activeLanesLabel read as the Spawn modal shows them', () => {
    expect(laneLine({ agent: 'Claude', branch: 'fix/checkout', files: 3, task: 'Fix the total' })).toBe(
      'Claude on fix/checkout · 3 files · Fix the total',
    );
    expect(laneLine({ agent: 'Codex', branch: 'test/flaky', files: 0, task: '' })).toBe(
      'Codex on test/flaky · 0 files · no task yet',
    );
    expect(activeLanesLabel(1)).toBe('1 lane active');
    expect(activeLanesLabel(3)).toBe('3 lanes active');
  });
});

describe('laneOverlapSummary', () => {
  const model = demoReadModel();
  it('names the other lanes by branch and unions their files; archived or branchless lanes are skipped', () => {
    const w = { overlaps: [] } as Pick<Worktree, 'overlaps'>;
    expect(laneOverlapSummary(model, w)).toBeNull();
    const two = {
      overlaps: [
        { worktreeId: ids.worktree.testFlaky, files: ['src/b.ts', 'src/a.ts'] },
        { worktreeId: ids.worktree.featPromo, files: ['src/a.ts'] },
        { worktreeId: 'wt-gone' as Worktree['id'], files: ['x'] },
      ],
    } as Pick<Worktree, 'overlaps'>;
    expect(laneOverlapSummary(model, two)).toEqual({
      branches: ['test/flaky', 'feat/promo'],
      files: ['src/a.ts', 'src/b.ts'],
    });
  });
});

describe('hotspots', () => {
  it('globs: `**` spans directories, `*` stays inside one, `?` is one char', () => {
    expect(globToRegExp('**/copy.ts').test('packages/core/src/copy.ts')).toBe(true);
    expect(globToRegExp('**/copy.ts').test('copy.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('a.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('src/a.ts')).toBe(false);
    expect(globToRegExp('src/**').test('src/deep/er/x.ts')).toBe(true);
    expect(globToRegExp('a?.ts').test('ab.ts')).toBe(true);
    expect(globToRegExp('a.ts').test('aXts')).toBe(false);
  });

  it('isHotspot uses the defaults when the project lists none, and the project list otherwise', () => {
    expect(DEFAULT_HOTSPOTS).toContain('**/migrations/**');
    expect(isHotspot('apps/desktop/src/main/db/migrations/0018_x.sql', [])).toBe(true);
    expect(isHotspot('packages/core/src/copy.ts', [])).toBe(true);
    expect(isHotspot('docs/handoff-discrepancies.md', [])).toBe(true);
    expect(isHotspot('packages/core/src/selectors/lanes.ts', [])).toBe(false);
    expect(isHotspot('packages/core/src/copy.ts', ['src/routes/**'])).toBe(false);
    expect(isHotspot('src\\routes\\index.ts', ['src/routes/**'])).toBe(true);
  });
});

describe('navLanes (ADR-0027 §1)', () => {
  const MIN = 60_000;
  /** acme-shop with its sessions set to the given states; everything else as the demo has it. */
  const withSessions = (
    patch: Record<string, Partial<Session>>,
    merged: Record<string, number | null> = {},
  ): ReadModel => {
    const m = demoReadModel();
    const byId = { ...m.sessions.byId };
    for (const [id, p] of Object.entries(patch)) {
      const s = byId[id];
      if (s === undefined) throw new Error(`fixture ${id}`);
      byId[id] = { ...s, ...p };
    }
    const wById = { ...m.worktrees.byId };
    for (const [id, at] of Object.entries(merged)) {
      const w = wById[id];
      if (w === undefined) throw new Error(`fixture ${id}`);
      wById[id] = { ...w, mergedAt: at };
    }
    return { ...m, sessions: { ...m.sessions, byId }, worktrees: { ...m.worktrees, byId: wById } };
  };
  const live = { pausedReason: null, endedAt: null, archivedAt: null };
  const done = { state: 'done' as const, pausedReason: null, endedAt: DEMO_NOW - 5 * MIN, archivedAt: null };

  it.each([
    ['needs-you', { state: 'needs-you' as const, ...live }, null, 'your-turn', 'Your turn'],
    ['working', { state: 'working' as const, ...live }, null, 'working', 'Working, 2m'],
    ['idle', { state: 'idle' as const, ...live }, null, 'idle', 'Waiting for you'],
    [
      'paused',
      { state: 'paused' as const, pausedReason: 'user' as const, endedAt: null },
      null,
      'paused',
      'Paused',
    ],
    ['done, not merged', done, null, 'ready', 'Ready to land'],
    ['done, merged', done, DEMO_NOW - 60 * MIN, 'landed', 'Landed 1h ago'],
  ])('%s → %s', (_name, patch, mergedAt, status, label) => {
    const s = demoReadModel().sessions.byId[ids.session.claude];
    if (s === undefined) throw new Error('fixture');
    const m = withSessions(
      { [ids.session.claude]: { ...patch, lastActivityAt: DEMO_NOW - 2 * MIN } as Partial<Session> },
      mergedAt === null ? {} : { [s.worktreeId]: mergedAt },
    );
    const lane = navLanes(m, ids.project.acmeShop, DEMO_NOW).find((l) => l.sessionId === ids.session.claude);
    expect(lane?.status).toBe(status);
    expect(lane?.statusLabel).toBe(label);
  });

  it('orders by whose move it is, then most recent; skips other projects, archived sessions and background tasks', () => {
    const m = withSessions({
      [ids.session.claude]: { state: 'working', ...live, lastActivityAt: DEMO_NOW - 9 * MIN },
      [ids.session.codex]: { state: 'needs-you', ...live, lastActivityAt: DEMO_NOW - 30 * MIN },
      [ids.session.gemini]: { state: 'working', ...live, lastActivityAt: DEMO_NOW - 1 * MIN },
      [ids.session.cursor]: { ...done, archivedAt: DEMO_NOW },
    });
    const lanes = navLanes(m, ids.project.acmeShop, DEMO_NOW);
    expect(lanes[0]?.sessionId).toBe(ids.session.codex);
    const working = lanes.filter((l) => l.status === 'working').map((l) => l.sessionId);
    expect(working.indexOf(ids.session.gemini)).toBeLessThan(working.indexOf(ids.session.claude));
    expect(lanes.map((l) => l.sessionId)).not.toContain(ids.session.cursor);
    for (const lane of lanes) expect(m.sessions.byId[lane.sessionId]?.projectId).toBe(ids.project.acmeShop);
    const withTask = withSessions({ [ids.session.claude]: { purpose: 'learn-run' } as Partial<Session> });
    expect(navLanes(withTask, ids.project.acmeShop, DEMO_NOW).map((l) => l.sessionId)).not.toContain(
      ids.session.claude,
    );
  });

  it('names a session with no task by its agent, falls back to the start time for age, and counts', () => {
    const m = withSessions({
      [ids.session.claude]: {
        firstMessage: null,
        note: null,
        state: 'working',
        ...live,
        lastActivityAt: null,
      },
    });
    const lane = navLanes(m, ids.project.acmeShop, DEMO_NOW).find((l) => l.sessionId === ids.session.claude);
    expect(lane?.task).toBe('Claude, no task yet');
    expect(lane?.statusLabel.startsWith('Working, ')).toBe(true);
    expect(navLanesLabel(1)).toBe('1 lane');
    expect(navLanesLabel(4)).toBe('4 lanes');
  });

  it('treats a done session whose worktree is missing as ready to land', () => {
    const m = withSessions({
      [ids.session.claude]: { ...done, worktreeId: 'wt_missing' } as Partial<Session>,
    });
    expect(
      navLanes(m, ids.project.acmeShop, DEMO_NOW).find((l) => l.sessionId === ids.session.claude)?.status,
    ).toBe('ready');
  });
});

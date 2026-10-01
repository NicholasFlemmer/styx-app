import { describe, expect, it } from 'vitest';
import { demoReadModel, ids } from '../fixtures/demo';
import type { Checkpoint } from '../model/checkpoint';
import type { ReadModel } from '../read-model';
import { changeLabel, laneSummary, laneSummaryLabel, stepOf, stepsLabel, turnDoneLabel } from './turns';

describe('stepOf (ADR-0027 §4)', () => {
  it.each([
    ['Read', 'src/pages/Settings.tsx', 'Read Settings.tsx'],
    ['Read', '', 'Read a file'],
    ['Read', '/', 'Read /'],
    ['Write', 'src/lib/prefs.ts', 'Wrote prefs.ts'],
    ['Write', '', 'Wrote a file'],
    ['Edit', 'C:\\repo\\theme.css', 'Edited theme.css'],
    ['MultiEdit', 'a/b.ts', 'Edited b.ts'],
    ['NotebookEdit', '', 'Edited a file'],
    ['Bash', 'pnpm   test settings', 'Ran pnpm test settings'],
    ['Bash', '', 'Ran a command'],
    ['Grep', 'usePref', 'Searched for “usePref”'],
    ['Grep', '', 'Searched the code'],
    ['Glob', '**/*.css', 'Looked for **/*.css'],
    ['Glob', '', 'Searched the code'],
    ['WebFetch', 'https://react.dev/reference/react', 'Read react.dev'],
    ['WebFetch', 'not a url', 'Read not a url'],
    ['WebFetch', 'http://', 'Read http:'],
    ['WebFetch', '', 'Read a web page'],
    ['WebSearch', 'prefers-color-scheme', 'Searched the web for “prefers-color-scheme”'],
    ['WebSearch', '', 'Searched the web'],
    ['Task', 'explore the code', 'Asked a helper agent'],
    ['TodoWrite', '', 'Updated its plan'],
    ['mcp__styx__land', 'agent/claude-3', 'mcp__styx__land agent/claude-3'],
    ['Custom', '', 'Custom'],
  ])('%s %j → %s', (tool, hint, label) => {
    expect(stepOf(tool, hint)).toBe(label);
  });

  it('clips a long command to one short line', () => {
    const label = stepOf('Bash', `pnpm vitest run ${'x'.repeat(100)}`);
    expect(label.length).toBeLessThanOrEqual('Ran '.length + 56);
    expect(label.endsWith('…')).toBe(true);
  });

  it('counts steps and failures', () => {
    expect(stepsLabel(1, 0)).toBe('1 step');
    expect(stepsLabel(12, 0)).toBe('12 steps');
    expect(stepsLabel(12, 2)).toBe('12 steps, 2 failed');
  });
});

describe('turn labels', () => {
  it.each([
    [0, 'Done in 0 s'],
    [40_000, 'Done in 40 s'],
    [4 * 60_000, 'Done in 4 min'],
    [72 * 60_000, 'Done in 1 h 12 min'],
    [-5, 'Done in 0 s'],
  ])('%i ms → %s', (ms, label) => {
    expect(turnDoneLabel(ms)).toBe(label);
  });

  it('says what changed', () => {
    expect(changeLabel({ files: 3, added: 42, removed: 3 })).toBe('3 files, +42 −3');
    expect(changeLabel({ files: 1, added: 2, removed: 0 })).toBe('1 file, +2 −0');
  });
});

describe('laneSummary', () => {
  const cp = (over: Partial<Checkpoint>): Checkpoint => ({
    id: `cp${Math.random()}`,
    sessionId: ids.session.claude,
    worktreeId: 'wt' as Checkpoint['worktreeId'],
    turn: 1,
    messageId: null,
    baseRef: 'base',
    ref: 'ref',
    files: 2,
    added: 10,
    removed: 1,
    createdAt: 0,
    settledAt: 1,
    revertedAt: null,
    screens: [],
    ...over,
  });
  const withCheckpoints = (list: Checkpoint[]): ReadModel => {
    const m = demoReadModel();
    return { ...m, checkpoints: { ...m.checkpoints, [ids.session.claude]: list } };
  };

  it('counts kept and undone turns with changes, skipping unsettled and empty ones, and reads the lane’s files', () => {
    const m = withCheckpoints([cp({}), cp({}), cp({ revertedAt: 5 }), cp({ ref: null }), cp({ files: 0 })]);
    const sum = laneSummary(m, ids.session.claude);
    const w = m.worktrees.byId[m.sessions.byId[ids.session.claude]?.worktreeId ?? ''];
    expect(sum).toEqual({
      kept: 2,
      undone: 1,
      files: w?.changes.files ?? 0,
      added: w?.changes.added ?? 0,
      removed: w?.changes.removed ?? 0,
    });
  });

  it('is null for an unknown session, and zero for a lane whose worktree is gone', () => {
    const m = demoReadModel();
    expect(laneSummary(m, 'sess_missing' as typeof ids.session.claude)).toBeNull();
    const s = m.sessions.byId[ids.session.claude];
    if (s === undefined) throw new Error('fixture');
    const gone: ReadModel = {
      ...m,
      sessions: {
        ...m.sessions,
        byId: { ...m.sessions.byId, [s.id]: { ...s, worktreeId: 'wt_gone' as typeof s.worktreeId } },
      },
      checkpoints: {},
    };
    expect(laneSummary(gone, s.id)).toEqual({ kept: 0, undone: 0, files: 0, added: 0, removed: 0 });
  });

  it.each([
    [{ kept: 0, undone: 0, files: 0, added: 0, removed: 0 }, 'No changes yet'],
    [{ kept: 0, undone: 1, files: 1, added: 1, removed: 0 }, '1 file changed'],
    [{ kept: 1, undone: 0, files: 1, added: 1, removed: 0 }, '1 turn kept, 1 file changed'],
    [{ kept: 3, undone: 0, files: 7, added: 90, removed: 4 }, '3 turns kept, 7 files changed'],
  ])('%j → %s', (sum, label) => {
    expect(laneSummaryLabel(sum)).toBe(label);
  });
});

import { describe, expect, it } from 'vitest';
import { copy } from '../copy';
import { demoReadModel, ids } from '../fixtures/demo';
import type { Checkpoint } from '../model/checkpoint';
import type { ReadModel } from '../read-model';
import {
  changeLabel,
  laneChanges,
  laneSummary,
  laneSummaryLabel,
  stepOf,
  stepsLabel,
  turnDoneLabel,
} from './turns';

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

describe('laneChanges (ADR-0027 §3)', () => {
  const claude = ids.session.claude;
  const base = demoReadModel();
  const firstUser = (base.transcripts[claude] ?? []).find((m) => m.payload.kind === 'user');
  const cp = (over: Partial<Checkpoint>): Checkpoint => ({
    id: 'cp',
    sessionId: claude,
    worktreeId: 'wt' as Checkpoint['worktreeId'],
    turn: 1,
    messageId: null,
    baseRef: 'b',
    ref: 'r',
    files: 2,
    added: 10,
    removed: 1,
    createdAt: 0,
    settledAt: 1,
    revertedAt: null,
    screens: [],
    ...over,
  });
  const patched = (patch: {
    checkpoints?: Checkpoint[];
    session?: Partial<NonNullable<ReadModel['sessions']['byId'][string]>>;
    worktree?: Partial<NonNullable<ReadModel['worktrees']['byId'][string]>>;
  }): ReadModel => {
    const m = demoReadModel();
    const s = m.sessions.byId[claude];
    if (s === undefined) throw new Error('fixture');
    const w = m.worktrees.byId[s.worktreeId];
    if (w === undefined) throw new Error('fixture');
    return {
      ...m,
      sessions: { ...m.sessions, byId: { ...m.sessions.byId, [claude]: { ...s, ...patch.session } } },
      worktrees: { ...m.worktrees, byId: { ...m.worktrees.byId, [w.id]: { ...w, ...patch.worktree } } },
      checkpoints: { ...m.checkpoints, [claude]: patch.checkpoints ?? [] },
    };
  };

  it('lists settled turns with changes, oldest first, titled by what was asked, and says what the agent last said', () => {
    const m = patched({
      checkpoints: [
        cp({ id: 'c2', turn: 2, revertedAt: 9 }),
        cp({ id: 'c1', turn: 1, messageId: firstUser?.id ?? null }),
        cp({ id: 'cx', turn: 3, ref: null }),
        cp({ id: 'c0', turn: 4, files: 0 }),
      ],
    });
    const c = laneChanges(m, claude);
    expect(c?.turns.map((t) => [t.checkpointId, t.title, t.undone])).toEqual([
      ['c1', firstUser?.body.split('\n')[0]?.trim(), false],
      ['c2', 'Turn 2', true],
    ]);
    expect(c?.turns[0]?.change).toBe('2 files, +10 −1');
    expect(c?.byLine).toBe('Claude, 1 turn');
    expect(c?.lastReply).not.toBeNull();
    expect(c?.loose).toBe(false);
    expect(c?.stateLabel).toBe(copy.chat.changes.state[c?.state ?? 'ready']);
  });

  it.each([
    ['working', 0, 'working'],
    ['idle', 0, 'idle'],
    ['needs-you', 0, 'needs-you'],
    ['done', 3, 'ready'],
    ['done', 0, 'done'],
  ] as const)('a %s session with %i files reads %s', (state, files, expected) => {
    const m = patched({
      session: { state, pausedReason: null, endedAt: state === 'done' ? 1 : null },
      worktree: { changes: { files, added: files, removed: 0 } },
    });
    expect(laneChanges(m, claude)?.state).toBe(expected);
  });

  it('flags files no turn accounts for; names overlapping lanes; counts turns; names an untitled lane', () => {
    const m = demoReadModel();
    const s = m.sessions.byId[claude];
    const other = Object.values(m.worktrees.byId).find((w) => w.id !== s?.worktreeId && w.branch !== null);
    if (s === undefined || other === undefined) throw new Error('fixture');
    const loose = patched({
      worktree: {
        changes: { files: 4, added: 9, removed: 0 },
        overlaps: [
          { worktreeId: other.id, files: ['a.ts'] },
          { worktreeId: 'wt_gone' as typeof other.id, files: [] },
        ],
      },
      session: { firstMessage: null, note: null },
      checkpoints: [cp({ id: 'a', turn: 1 }), cp({ id: 'b', turn: 2 })].filter(() => false),
    });
    const c = laneChanges(loose, claude);
    expect(c?.loose).toBe(true);
    expect(c?.overlap).toBe(`Also changed in ${other.branch}`);
    expect(c?.headline).toBe('Claude, no task yet');
    expect(c?.byLine).toBe('Claude, 0 turns');
    // A turn whose request row is gone is still listed, by number.
    expect(
      laneChanges(patched({ checkpoints: [cp({ id: 'g', messageId: 'gone' })] }), claude)?.turns[0]?.title,
    ).toBe('Turn 1');
    const two = laneChanges(
      patched({ checkpoints: [cp({ id: 'a', turn: 1 }), cp({ id: 'b', turn: 2 })] }),
      claude,
    );
    expect(two?.byLine).toBe('Claude, 2 turns');
    expect(two?.overlap).toBe('No other lane touches these files');
  });

  it('is null for an unknown session; copes with no transcript, no reply and a missing worktree; clips a long reply', () => {
    expect(laneChanges(demoReadModel(), 'nope' as typeof claude)).toBeNull();
    const m = demoReadModel();
    const s = m.sessions.byId[claude];
    if (s === undefined) throw new Error('fixture');
    const bare: ReadModel = {
      ...m,
      sessions: {
        ...m.sessions,
        byId: { ...m.sessions.byId, [claude]: { ...s, worktreeId: 'wt_gone' as typeof s.worktreeId } },
      },
      transcripts: { ...m.transcripts, [claude]: [] },
    };
    expect(laneChanges(bare, claude)).toMatchObject({ lastReply: null, files: 0, loose: false });
    const noTranscript: ReadModel = { ...bare, transcripts: {} };
    expect(laneChanges(noTranscript, claude)?.lastReply).toBeNull();
    const reply = (m.transcripts[claude] ?? []).find((x) => x.payload.kind === 'agent');
    if (reply === undefined) throw new Error('fixture');
    const long: ReadModel = {
      ...m,
      transcripts: { ...m.transcripts, [claude]: [{ ...reply, seq: 999, body: 'y'.repeat(2000) }] },
    };
    const clipped = laneChanges(long, claude)?.lastReply ?? '';
    expect(clipped.length).toBe(1200);
    expect(clipped.endsWith('…')).toBe(true);
    const longAsk: ReadModel = {
      ...long,
      transcripts: {
        ...long.transcripts,
        [claude]: [
          { ...reply, id: 'u' as typeof reply.id, payload: { kind: 'user' }, body: 'z'.repeat(150) },
        ],
      },
      checkpoints: { [claude]: [cp({ id: 'c', messageId: 'u' })] },
    };
    expect(laneChanges(longAsk, claude)?.turns[0]?.title.length).toBe(100);
  });
});

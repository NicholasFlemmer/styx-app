import type { Checkpoint } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { laneItems, type LaneContext, type LaneItem } from './lane-turns';
import type { TranscriptItem } from './transcript-items';

const user = (id: string, text: string): TranscriptItem => ({ id, kind: 'user', text, attachments: [] });
const agent = (id: string, text: string, streaming = false): TranscriptItem => ({
  id,
  kind: 'agent',
  text,
  streaming,
});
const tool = (
  id: string,
  name: string,
  hint: string,
  status: 'running' | 'ok' | 'error' = 'ok',
): TranscriptItem => ({
  id,
  kind: 'tool',
  tool: name,
  hint,
  status,
  detail: null,
});
const checkpointRow = (id: string, reverted = false): TranscriptItem => ({
  id: `checkpoint:${id}`,
  kind: 'checkpoint',
  checkpointId: id,
  turn: 1,
  files: 3,
  added: 42,
  removed: 3,
  reverted,
});
const cp = (id: string, over: Partial<Checkpoint> = {}): Checkpoint => ({
  id,
  sessionId: 'sess' as Checkpoint['sessionId'],
  worktreeId: 'wt' as Checkpoint['worktreeId'],
  turn: 1,
  messageId: null,
  baseRef: 'b',
  ref: 'r',
  files: 3,
  added: 42,
  removed: 3,
  createdAt: 0,
  settledAt: 4 * 60_000,
  revertedAt: null,
  screens: [],
  ...over,
});
const ctx = (over: Partial<LaneContext> = {}): LaneContext => ({
  checkpoints: [],
  atOf: () => Date.UTC(2026, 9, 1, 9, 12),
  live: false,
  expanded: new Set(),
  showAll: false,
  clock: (ms) => new Date(ms).toISOString().slice(11, 16),
  screenUrl: (id, side) => `styx-device://checkpoint/${id}/${side}`,
  ...over,
});
const kinds = (items: LaneItem[]) => items.map((i) => i.kind);

describe('laneItems (ADR-0027 §3 / §4)', () => {
  it('turns a run of tool rows into plain steps; the trailing run of a live turn is live', () => {
    const items = [
      { id: 's0', kind: 'system', text: 'session started' } as TranscriptItem,
      user('u1', 'Add dark mode'),
      tool('t1', 'Read', 'src/Settings.tsx'),
      tool('t2', 'Grep', 'usePref'),
      agent('a1', 'Found it.'),
      tool('t3', 'Bash', 'pnpm test', 'running'),
    ];
    const out = laneItems(items, ctx({ live: true }));
    expect(kinds(out)).toEqual(['system', 'user', 'steps', 'agent', 'steps']);
    const [first, second] = out.filter((i) => i.kind === 'steps') as Extract<LaneItem, { kind: 'steps' }>[];
    expect(first?.steps.map((s) => s.label)).toEqual(['Read Settings.tsx', 'Searched for “usePref”']);
    expect(first?.live).toBe(false);
    expect(first?.summary).toBe('2 steps');
    expect(second?.live).toBe(true);
    expect(first?.latest).toBe(true);
    expect(second?.tools.map((t) => t.id)).toEqual(['t3']);
    // Not live: nothing is.
    expect(laneItems(items, ctx()).filter((i) => i.kind === 'steps' && i.live)).toEqual([]);
  });

  it('ends a turn with changes on paper, carrying the last reply, how long it took and its screenshots', () => {
    const items = [
      user('u1', 'Add dark mode'),
      agent('a1', 'Looking.'),
      tool('t1', 'Edit', 'theme.css', 'error'),
      agent('a2', 'Done: dark mode added.'),
      checkpointRow('c1'),
    ];
    const out = laneItems(items, ctx({ checkpoints: [cp('c1', { screens: ['before', 'after'] })] }));
    expect(kinds(out)).toEqual(['user', 'agent', 'steps', 'result']);
    const result = out.at(-1) as Extract<LaneItem, { kind: 'result' }>;
    expect(result).toMatchObject({
      text: 'Done: dark mode added.',
      done: 'Done in 4 min',
      change: '3 files, +42 −3',
      undone: false,
      before: 'styx-device://checkpoint/c1/before',
      after: 'styx-device://checkpoint/c1/after',
    });
    expect((out[2] as Extract<LaneItem, { kind: 'steps' }>).summary).toBe('1 step, 1 failed');
  });

  it('leaves a still-streaming reply where it is, and copes with an unknown or unsettled checkpoint', () => {
    const out = laneItems([user('u1', 'Go'), agent('a1', 'Writ', true), checkpointRow('c9', true)], ctx());
    expect(kinds(out)).toEqual(['user', 'agent', 'result']);
    expect(out.at(-1)).toMatchObject({
      text: null,
      done: '',
      undone: true,
      before: undefined,
      after: undefined,
    });
  });

  it('folds turns before the latest to receipts: kept, undone or answered, with the time', () => {
    const items = [
      user('u1', 'Add a dark-mode switch\nwith details'),
      agent('a1', 'Added.'),
      checkpointRow('c1'),
      user('u2', 'Save the choice'),
      agent('a2', 'Saved.'),
      checkpointRow('c2', true),
      user('u3', 'How does checkout work?'),
      agent('a3', 'Like this.'),
      user('u4', 'Now checkout'),
      tool('t9', 'Read', 'checkout.ts', 'running'),
    ];
    const settled = Date.UTC(2026, 9, 1, 9, 31);
    const out = laneItems(
      items,
      ctx({ live: true, checkpoints: [cp('c1'), cp('c2', { settledAt: settled })] }),
    );
    // Live: the turn before the latest stays open too (a steer, or the last result in view).
    expect(kinds(out)).toEqual(['earlier', 'receipt', 'receipt', 'user', 'agent', 'user', 'steps']);
    expect(out[0]).toMatchObject({ label: '2 earlier turns', folded: true });
    expect(out.slice(1, 3)).toMatchObject([
      { title: 'Add a dark-mode switch', state: 'kept', meta: 'Kept 00:04' },
      { title: 'Save the choice', state: 'undone', meta: 'Undone 09:31' },
    ]);
    // At rest only the latest stays open.
    const rest = laneItems(items, ctx({ checkpoints: [cp('c1'), cp('c2', { settledAt: settled })] }));
    expect(kinds(rest)).toEqual(['earlier', 'receipt', 'receipt', 'receipt', 'user', 'steps']);
    expect(rest[3]).toMatchObject({
      title: 'How does checkout work?',
      state: 'answered',
      meta: 'Answered 09:12',
    });
  });

  it('opens one turn from its receipt as a group under it, or every turn with Show them', () => {
    const items = [user('u1', 'First'), agent('a1', 'One.'), user('u2', 'Second'), agent('a2', 'Two.')];
    const one = laneItems(items, ctx({ expanded: new Set(['u1']) }));
    expect(kinds(one)).toEqual(['earlier', 'turn', 'user', 'agent']);
    expect(one[1]).toMatchObject({ turnId: 'u1', title: 'First', state: 'answered' });
    const group = one[1] as Extract<LaneItem, { kind: 'turn' }>;
    expect(kinds(group.items)).toEqual(['user', 'agent']);
    const all = laneItems(items, ctx({ showAll: true }));
    expect(kinds(all)).toEqual(['earlier', 'turn', 'user', 'agent']);
    expect(all[0]).toMatchObject({ label: '1 earlier turn', folded: false });
    // Under Show them a receipt click folds just that turn again.
    expect(kinds(laneItems(items, ctx({ showAll: true, expanded: new Set(['u1']) })))).toEqual([
      'earlier',
      'receipt',
      'user',
      'agent',
    ]);
  });

  it('never folds a turn that is still asking the person something, and a receipt has a title and a time', () => {
    const items = [
      user('u1', 'Deploy it'),
      {
        id: 'd1',
        kind: 'decision',
        text: 'Which?',
        options: ['A', 'B'],
        askId: null,
        chosen: null,
        open: true,
      } as TranscriptItem,
      user('u2', ''),
      agent('a2', 'ok'),
      user('u3', 'last'),
    ];
    const out = laneItems(items, ctx({ atOf: () => null }));
    expect(kinds(out)).toEqual(['earlier', 'user', 'decision', 'receipt', 'user']);
    expect(out[3]).toMatchObject({ title: 'Answered', meta: 'Answered' });
  });

  it('a long first line is clipped for the receipt', () => {
    const long = 'x'.repeat(120);
    const out = laneItems([user('u1', long), user('u2', 'next')], ctx());
    const receipt = out.find((i) => i.kind === 'receipt') as Extract<LaneItem, { kind: 'receipt' }>;
    expect(receipt.title.length).toBe(90);
    expect(receipt.title.endsWith('…')).toBe(true);
  });
});

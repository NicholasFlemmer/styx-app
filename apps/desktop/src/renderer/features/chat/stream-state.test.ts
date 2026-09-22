import { fixtures, upsertRows, type ReadModel, type SessionId, type TranscriptMessage } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { elapsedLabel, thinkingLabel, wholeSeconds, workingLine } from './stream-state';

const claude = fixtures.ids.session.claude as SessionId;
const codex = fixtures.ids.session.codex as SessionId;
const NOW = fixtures.DEMO_NOW;

describe('thinkingLabel', () => {
  it.each([
    ['streaming', null, 'Thinking…'],
    ['streaming', 4200, 'Thinking…'],
    ['done', 4200, 'Thought for 4s'],
    ['done', 4600, 'Thought for 5s'],
    ['done', 0, 'Thought for 1s'],
    ['done', 120, 'Thought for 1s'],
    ['done', null, 'Thinking'],
  ] as const)('%s / %s → %s', (status, ms, expected) => {
    expect(thinkingLabel(status, ms)).toBe(expected);
  });

  it('elapsedLabel reads seconds under a minute and minutes + zero-padded seconds past it', () => {
    expect(elapsedLabel(0)).toBe('1s');
    expect(elapsedLabel(59_400)).toBe('59s');
    expect(elapsedLabel(60_000)).toBe('1m 00s');
    expect(elapsedLabel(187_000)).toBe('3m 07s');
    expect(elapsedLabel(2_400_000)).toBe('40m 00s');
  });

  it('wholeSeconds rounds and floors at 1', () => {
    expect(wholeSeconds(0)).toBe(1);
    expect(wholeSeconds(1499)).toBe(1);
    expect(wholeSeconds(1500)).toBe(2);
    expect(wholeSeconds(59_400)).toBe(59);
  });
});

const withRows = (model: ReadModel, rows: Partial<TranscriptMessage>[]): ReadModel => {
  const base = model.transcripts[claude]?.[0];
  if (base === undefined) throw new Error('fixture');
  const existing = model.transcripts[claude] ?? [];
  const next = rows.map((r, i) => ({
    ...base,
    id: `m-x${i}` as typeof base.id,
    seq: 100 + i,
    askId: null,
    ...r,
  }));
  return { ...model, transcripts: { ...model.transcripts, [claude]: [...existing, ...next] } };
};

describe('workingLine', () => {
  const model = fixtures.demoReadModel();

  it('null unless the session is working', () => {
    expect(workingLine(model, codex, NOW)).toBeNull();
    const s = model.sessions.byId[claude];
    if (s === undefined) throw new Error('fixture');
    const idle: ReadModel = { ...model, sessions: upsertRows(model.sessions, [{ ...s, state: 'idle' }]) };
    expect(workingLine(idle, claude, NOW)).toBeNull();
    expect(workingLine(model, 'nope' as SessionId, NOW)).toBeNull();
  });

  it('demo Claude session (working, last row a decision): "Working…" counted from the last user message', () => {
    const lastUser = (model.transcripts[claude] ?? []).find((m) => m.payload.kind === 'user');
    if (lastUser === undefined) throw new Error('fixture');
    expect(workingLine(model, claude, NOW)).toEqual({
      label: 'Working…',
      elapsedMs: NOW - lastUser.createdAt,
    });
  });

  it('null while the last row is streaming (agent or thinking): the cursor shows progress', () => {
    expect(
      workingLine(
        withRows(model, [{ body: 'Rea', payload: { kind: 'agent', streaming: true } }]),
        claude,
        NOW,
      ),
    ).toBeNull();
    expect(
      workingLine(
        withRows(model, [
          { body: 'hm', payload: { kind: 'thinking', status: 'streaming', durationMs: null } },
        ]),
        claude,
        NOW,
      ),
    ).toBeNull();
    // A settled agent row (streaming false / absent) does not suppress it.
    expect(
      workingLine(
        withRows(model, [{ body: 'Done.', payload: { kind: 'agent', streaming: false } }]),
        claude,
        NOW,
      )?.label,
    ).toBe('Working…');
  });

  it.each([
    ['user', { kind: 'user' }, 'Thinking…'],
    ['done thinking', { kind: 'thinking', status: 'done', durationMs: 4200 }, 'Thinking…'],
    ['agent', { kind: 'agent' }, 'Working…'],
    ['system', { kind: 'system' }, 'Working…'],
    [
      'finished tool',
      { kind: 'tool', tool: 'Read', hint: 'a.ts', toolUseId: null, status: 'ok', detail: null },
      'Working…',
    ],
  ] as const)('last row %s → %s', (_name, payload, label) => {
    expect(workingLine(withRows(model, [{ body: 'x', payload }]), claude, NOW)?.label).toBe(label);
  });

  it('"Running {tool}…" while the latest tool call is still running, even under a later user row', () => {
    const running = {
      kind: 'tool',
      tool: 'Bash',
      hint: 'pnpm test',
      toolUseId: 't1',
      status: 'running',
      detail: null,
    } as const;
    expect(workingLine(withRows(model, [{ body: '', payload: running }]), claude, NOW)?.label).toBe(
      'Running Bash…',
    );
    // An older running tool superseded by a finished one no longer wins.
    const finished = { ...running, toolUseId: 't2', status: 'ok' } as const;
    expect(
      workingLine(
        withRows(model, [
          { body: '', payload: running },
          { body: '', payload: finished },
        ]),
        claude,
        NOW,
      )?.label,
    ).toBe('Working…');
  });

  it('elapsed falls back to lastActivityAt without a user row, else 0; never negative', () => {
    const s = model.sessions.byId[claude];
    if (s === undefined) throw new Error('fixture');
    const noRows: ReadModel = { ...model, transcripts: { ...model.transcripts, [claude]: [] } };
    expect(workingLine(noRows, claude, NOW)?.elapsedMs).toBe(NOW - (s.lastActivityAt ?? 0));
    const noActivity: ReadModel = {
      ...noRows,
      sessions: upsertRows(model.sessions, [{ ...s, lastActivityAt: null }]),
    };
    expect(workingLine(noActivity, claude, NOW)?.elapsedMs).toBe(0);
    expect(workingLine(model, claude, 0)?.elapsedMs).toBe(0);
  });
});

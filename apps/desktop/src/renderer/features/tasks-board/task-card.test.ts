import { fixtures, type SessionId, type TranscriptMessage } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { CARD_STEPS, taskCard } from './task-card';

const claude = fixtures.ids.session.claude as SessionId;
const row = (seq: number, payload: TranscriptMessage['payload'], body = ''): TranscriptMessage => ({
  id: `m${seq}` as TranscriptMessage['id'],
  sessionId: claude,
  seq,
  body,
  payload,
  askId: null,
  createdAt: seq,
});
const tool = (seq: number, hint: string, status: 'running' | 'ok' | 'error' = 'ok') =>
  row(seq, { kind: 'tool', tool: 'Read', hint, toolUseId: null, status, detail: null });

describe('taskCard (#138)', () => {
  it('lists the latest steps since the person last spoke, the status line and what the lane holds', () => {
    const m = fixtures.demoReadModel();
    const s = m.sessions.byId[claude];
    if (s === undefined) throw new Error('fixture');
    const model = {
      ...m,
      sessions: { ...m.sessions, byId: { ...m.sessions.byId, [claude]: { ...s, note: ' Reading pay.ts ' } } },
      transcripts: {
        ...m.transcripts,
        [claude]: [
          row(0, { kind: 'user' }, 'Add validation'),
          tool(1, 'old.ts'),
          row(2, { kind: 'user' }, 'Now checkout'),
          tool(3, 'a.ts'),
          tool(4, 'b.ts'),
          tool(5, 'c.ts', 'error'),
          tool(6, 'd.ts', 'running'),
        ],
      },
    };
    const card = taskCard(model, claude);
    expect(card.steps).toHaveLength(CARD_STEPS);
    expect(card.steps.map((x) => x.key)).toEqual(['m4', 'm5', 'm6']);
    expect(card.steps.map((x) => x.status)).toEqual(['ok', 'error', 'running']);
    expect(card.steps[2]?.label).toContain('d.ts');
    expect(card.note).toBe('Reading pay.ts');
    expect(typeof card.summary).toBe('string');
  });

  it('a lane with nothing yet has no steps and no status line', () => {
    const m = fixtures.demoReadModel();
    const s = m.sessions.byId[claude];
    if (s === undefined) throw new Error('fixture');
    const model = {
      ...m,
      sessions: { ...m.sessions, byId: { ...m.sessions.byId, [claude]: { ...s, note: null } } },
      transcripts: { ...m.transcripts, [claude]: [] },
    };
    expect(taskCard(model, claude)).toMatchObject({ steps: [], note: null });
  });
});

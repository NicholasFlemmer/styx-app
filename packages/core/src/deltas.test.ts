import { describe, expect, it } from 'vitest';
import { applyDelta, applyDeltas, deltaSchema, hasSeqGap } from './deltas';
import type { Delta } from './deltas';
import { demoFixture, demoReadModel, ids } from './fixtures/demo';
import { DEFAULT_APP_SETTINGS } from './model/settings';
import { emptyReadModel, removeRows, rows, tableFrom, upsertRows } from './read-model';

describe('applyDelta', () => {
  const model = demoReadModel();
  const f = demoFixture();
  const session = f.sessions[1];
  if (session === undefined) throw new Error('fixture');

  it('is idempotent for every op', () => {
    const deltas: Delta[] = [
      {
        op: 'upsert',
        table: 'sessions',
        rows: [{ ...session, state: 'working', note: 'Applying migration 0042 to prod' }],
      },
      { op: 'remove', table: 'grants', ids: [ids.grant.awsClaude] },
      {
        op: 'transcript.append',
        sessionId: ids.session.codex,
        messages: [
          {
            ...(f.transcripts[ids.session.codex]?.[0] as NonNullable<(typeof f.transcripts)[string]>[number]),
            id: ids.message(99),
            seq: 9,
          },
        ],
      },
      { op: 'transcript.patch', sessionId: ids.session.codex, messageId: ids.message(11), body: 'streamed' },
      { op: 'transcript.replace', sessionId: ids.session.blog, messages: [] },
      { op: 'hunks.replace', sessionId: ids.session.claude, hunks: [] },
      { op: 'discovery.set', ides: [], clis: f.clis },
      { op: 'settings.set', app: { ...DEFAULT_APP_SETTINGS, theme: 'dark' } },
      { op: 'popouts.set', sessionIds: [ids.session.codex] },
    ];
    for (const delta of deltas) {
      expect(deltaSchema.safeParse(delta).success).toBe(true);
      const once = applyDelta(model, delta);
      const twice = applyDelta(once, delta);
      expect(twice).toEqual(once);
      expect(once).not.toBe(model);
    }
  });

  it('upsert keeps insertion order and replaces rows; no-op upsert/remove return the same model', () => {
    const next = applyDelta(model, { op: 'upsert', table: 'sessions', rows: [{ ...session, note: 'x' }] });
    expect(next.sessions.ids).toEqual(model.sessions.ids);
    expect(next.sessions.byId[session.id]?.note).toBe('x');
    expect(applyDelta(model, { op: 'upsert', table: 'sessions', rows: [] })).toBe(model);
    expect(applyDelta(model, { op: 'remove', table: 'sessions', ids: ['nope'] })).toBe(model);
    const removed = applyDelta(model, { op: 'remove', table: 'sessions', ids: [session.id] });
    expect(removed.sessions.ids).not.toContain(session.id);
    expect(rows(removed.sessions)).toHaveLength(7);
  });

  it('transcript.append skips already-known ids; patch is a no-op for unknown ids or equal bodies', () => {
    const existing = model.transcripts[ids.session.codex] ?? [];
    expect(
      applyDelta(model, { op: 'transcript.append', sessionId: ids.session.codex, messages: [...existing] }),
    ).toBe(model);
    const fresh = applyDelta(model, {
      op: 'transcript.append',
      sessionId: ids.session.side,
      messages: [{ ...(existing[0] as NonNullable<(typeof existing)[number]>), sessionId: ids.session.side }],
    });
    expect(fresh.transcripts[ids.session.side]).toHaveLength(1);
    expect(
      applyDelta(model, {
        op: 'transcript.patch',
        sessionId: ids.session.codex,
        messageId: 'nope',
        body: 'x',
      }),
    ).toBe(model);
    expect(
      applyDelta(model, {
        op: 'transcript.patch',
        sessionId: ids.session.side,
        messageId: 'nope',
        body: 'x',
      }),
    ).toBe(model);
    const same = existing[1] as NonNullable<(typeof existing)[number]>;
    expect(
      applyDelta(model, {
        op: 'transcript.patch',
        sessionId: ids.session.codex,
        messageId: same.id,
        body: same.body,
      }),
    ).toBe(model);
    const patched = applyDelta(model, {
      op: 'transcript.patch',
      sessionId: ids.session.codex,
      messageId: same.id,
      body: 'streamed',
    });
    expect(patched.transcripts[ids.session.codex]?.[1]?.body).toBe('streamed');
    expect(patched.transcripts[ids.session.codex]?.[0]).toBe(existing[0]);
  });

  it('settings.set merges project settings and keeps app when omitted', () => {
    const next = applyDelta(model, { op: 'settings.set', project: {} });
    expect(next.settings.app).toBe(model.settings.app);
    expect(next.settings.project).toEqual(model.settings.project);
    const app = applyDelta(model, { op: 'settings.set', app: { ...DEFAULT_APP_SETTINGS, dnd: true } });
    expect(app.settings.app.dnd).toBe(true);
    expect(app.settings.project).toBe(model.settings.project);
  });

  it('applyDeltas bumps seq; hasSeqGap detects a missing batch', () => {
    const next = applyDeltas(model, { seq: 2, deltas: [{ op: 'popouts.set', sessionIds: [] }] });
    expect(next.seq).toBe(2);
    expect(applyDeltas(model, { seq: model.seq, deltas: [] })).toBe(model);
    expect(applyDeltas(model, { seq: 5, deltas: [] }).seq).toBe(5);
    expect(hasSeqGap(model, { seq: 2 })).toBe(false);
    expect(hasSeqGap(model, { seq: 3 })).toBe(true);
  });

  it('table helpers', () => {
    const t = tableFrom([{ id: 'a' }, { id: 'b' }, { id: 'a' }]);
    expect(t.ids).toEqual(['a', 'b']);
    expect(upsertRows(t, [])).toBe(t);
    expect(removeRows(t, ['zzz'])).toBe(t);
    expect(rows(removeRows(t, ['a']))).toEqual([{ id: 'b' }]);
    expect(emptyReadModel(DEFAULT_APP_SETTINGS).sessions.ids).toEqual([]);
  });
});

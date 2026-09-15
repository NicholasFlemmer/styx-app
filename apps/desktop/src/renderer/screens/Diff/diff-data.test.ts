import { fixtures, type HunkId, type ProjectId, type SessionId } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { clampFocus, fileCounts, modLabel, reviewCounts, reviewHunks, reviewOf, reviewSessionId } from './diff-data';

const acme = fixtures.ids.project.acmeShop as ProjectId;
const claude = fixtures.ids.session.claude as SessionId;
const codex = fixtures.ids.session.codex as SessionId;

const withStatus = (statuses: Record<number, 'accepted' | 'rejected' | 'stale'>) => {
  const model = fixtures.demoReadModel();
  const hunks = (model.hunks[claude] ?? []).map((h, i) => ({ ...h, status: statuses[i + 1] ?? h.status }));
  return { ...model, hunks: { ...model.hunks, [claude]: hunks } };
};

describe('Diff review data', () => {
  it('reviews the active session when it has hunks, else the first project session with hunks', () => {
    const model = fixtures.demoReadModel();
    expect(reviewSessionId(model, acme, claude)).toBe(claude);
    expect(reviewSessionId(model, acme, codex)).toBe(claude);
    expect(reviewSessionId(model, acme, null)).toBe(claude);
    expect(reviewSessionId(fixtures.emptyReadModel(), null, null)).toBeNull();
  });

  it('lists the prototype hunks with ranges and spaced-gutter rows, dropping stale ones', () => {
    const hunks = reviewHunks(withStatus({ 3: 'stale' }), claude);
    expect(hunks.map((h) => [h.file, h.range, h.status])).toEqual([
      ['checkout.ts', '@@ -1,2 +1,3 @@', 'pending'],
      ['checkout.ts', '@@ -4,3 +5,5 @@', 'pending'],
    ]);
    expect(hunks[0]?.rows).toEqual([
      { kind: 'context', text: 'import { sum } from "./cart"' },
      { kind: 'add', text: 'import { validate } from "./validate"' },
      { kind: 'context', text: '' },
    ]);
  });

  it('meta counts live changes, reverted (rejected) and reviewed (accepted); stale ones are not changes', () => {
    expect(reviewOf(fixtures.demoReadModel(), acme, claude).meta).toBe(
      'Claude · fix/checkout · 3 changes · 0 reverted · 0 reviewed',
    );
    const r = reviewOf(withStatus({ 1: 'accepted', 2: 'rejected' }), acme, claude);
    expect(r.counts).toEqual({ reverted: 1, reviewed: 1, pending: 1 });
    expect(r.meta).toBe('Claude · fix/checkout · 3 changes · 1 reverted · 1 reviewed');
    expect(reviewOf(withStatus({ 2: 'rejected', 3: 'stale' }), acme, claude).meta).toBe(
      'Claude · fix/checkout · 2 changes · 1 reverted · 0 reviewed',
    );
    expect(reviewCounts([])).toEqual({ reverted: 0, reviewed: 0, pending: 0 });
  });

  it('files carry added-line counts in first-seen order', () => {
    const hunks = reviewHunks(fixtures.demoReadModel(), claude);
    expect(fileCounts(hunks)).toEqual([
      { file: 'checkout.ts', added: 2 },
      { file: 'validate.ts', added: 2 },
    ]);
  });

  it('empty model: no session, placeholders in the meta', () => {
    const r = reviewOf(fixtures.emptyReadModel(), null, null);
    expect(r.sessionId).toBeNull();
    expect(r.hunks).toEqual([]);
    expect(r.meta).toBe('— · — · 0 changes · 0 reverted · 0 reviewed');
  });

  it.each([
    ['darwin', '⌘'],
    ['win32', 'Ctrl'],
  ] as const)('modLabel(%s) → %s', (platform, expected) => {
    expect(modLabel(platform)).toBe(expected);
  });

  it('clamps the focus index into the hunk range', () => {
    expect(clampFocus(5, 3)).toBe(2);
    expect(clampFocus(-1, 3)).toBe(0);
    expect(clampFocus(2, 0)).toBe(0);
  });

  it('hunk ids are the fixture ids', () => {
    expect(reviewHunks(fixtures.demoReadModel(), claude).map((h) => h.id)).toEqual(
      [1, 2, 3].map((n) => fixtures.ids.hunk(n) as HunkId),
    );
  });
});

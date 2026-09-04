import { fixtures } from '@styx/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWindow, makeTestApp } from '../test-support';

describe('Publisher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces deltas emitted within a tick into one numbered store.delta batch per window', () => {
    const { app, win } = makeTestApp();
    const second = new FakeWindow(2);
    app.publisher.register(second);
    app.publisher.upsert('projects', [fixtures.ids.project.acmeShop]);
    app.publisher.remove('sessions', ['gone']);
    expect(win.batches()).toHaveLength(0);
    vi.advanceTimersByTime(16);
    expect(win.batches()).toHaveLength(1);
    expect(win.batches()[0]).toMatchObject({ seq: 1, deltas: [{ op: 'upsert' }, { op: 'remove' }] });
    expect(second.batches()[0]?.seq).toBe(1);
    app.publisher.upsert('targets', [fixtures.ids.target.vercelProd]);
    vi.advanceTimersByTime(16);
    expect(win.batches().map((b) => b.seq)).toEqual([1, 2]);
    expect(app.publisher.seq).toBe(2);
  });

  it('re-reads rows through the repos and converts missing ids into removes', () => {
    const { app, win } = makeTestApp();
    app.publisher.upsert('projects', [fixtures.ids.project.acmeShop, 'missing-id']);
    app.publisher.flush();
    const batch = win.batches()[0];
    expect(batch?.deltas).toEqual([
      expect.objectContaining({
        op: 'upsert',
        table: 'projects',
        rows: [expect.objectContaining({ id: fixtures.ids.project.acmeShop, name: 'acme-shop' })],
      }),
      { op: 'remove', table: 'projects', ids: ['missing-id'] },
    ]);
  });

  it('flushes pending deltas before an event and before a snapshot so ordering is preserved', () => {
    const { app, win } = makeTestApp();
    app.publisher.upsert('grants', [fixtures.ids.grant.awsClaude]);
    app.publisher.sendEvent('grant.result', {
      grantId: fixtures.ids.grant.awsClaude,
      sessionId: null,
      outcome: 'denied',
    });
    expect(win.sent.map((m) => m.channel)).toEqual(['styx:store', 'styx:evt']);
    app.publisher.upsert('grants', [fixtures.ids.grant.awsClaude]);
    const snap = app.publisher.snapshot();
    expect(snap.seq).toBe(2);
    expect(win.batches().at(-1)?.seq).toBe(2);
  });

  it('batches pty bytes per id with a per-id sequence and drops destroyed windows', () => {
    const { app, win } = makeTestApp();
    const gone = new FakeWindow(3);
    app.publisher.register(gone);
    gone.destroyed = true;
    app.publisher.pty('s1', 'ab');
    app.publisher.pty('s1', 'cd');
    app.publisher.pty('s2', 'x');
    vi.advanceTimersByTime(16);
    const pty = win.sent.filter((m) => m.channel === 'styx:pty').map((m) => m.payload);
    expect(pty).toEqual([
      { id: 's1', data: 'abcd', seq: 1 },
      { id: 's2', data: 'x', seq: 1 },
    ]);
    app.publisher.pty('s1', 'e');
    app.publisher.ptyExit('s1', 0);
    expect(win.sent.filter((m) => m.channel === 'styx:pty').at(-1)?.payload).toEqual({
      id: 's1',
      data: 'e',
      seq: 2,
    });
    expect(win.events('pty.exit')).toEqual([{ id: 's1', exitCode: 0 }]);
    expect(gone.sent).toHaveLength(0);
    expect(app.publisher.isRegistered(3)).toBe(false);
  });
});

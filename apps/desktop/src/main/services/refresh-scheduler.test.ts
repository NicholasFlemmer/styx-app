import { fixtures, type Target } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { RefreshScheduler, type RefreshReason } from './refresh-scheduler';

const MIN = 60_000;
const NOW = fixtures.DEMO_NOW;

const target = (id: string, over: Partial<Target> = {}): Target => ({
  id: id as Target['id'],
  projectId: 'p' as Target['projectId'],
  provider: 'gcp',
  name: id,
  env: 'staging',
  authMethod: 'cli',
  policy: 'ask',
  policySource: 'app',
  credentialRef: `styx:v1:gcp:${id}:cli`,
  health: 'ok',
  healthCheckedAt: null,
  expiredAt: null,
  config: {},
  fromProjectFile: false,
  createdAt: 0,
  ...over,
});

function harness(targets: Target[], opts: { intervalMs?: number; failing?: string } = {}) {
  const clock = new ManualClock(NOW);
  const calls: { id: string; reason: RefreshReason }[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const rows = new Map(targets.map((t) => [t.id, t]));
  const scheduler = new RefreshScheduler({
    repos: {
      targets: {
        all: () => [...rows.values()],
        get: (id: string) => rows.get(id as Target['id']) ?? null,
      } as never,
    },
    clock,
    checkHealth: async (t, reason) => {
      calls.push({ id: t.id, reason });
      if (t.id === opts.failing) throw new Error('boom');
      rows.set(t.id, { ...t, healthCheckedAt: clock.now() });
    },
    ...(opts.intervalMs !== undefined ? { intervalMs: opts.intervalMs } : {}),
    setInterval: (fn, ms) => {
      const h = { fn, ms, cleared: false, unref: () => undefined };
      timers.push(h);
      return h;
    },
    clearInterval: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
  });
  return { scheduler, clock, calls, timers, rows };
}

describe('RefreshScheduler', () => {
  it('arms a 30 min interval that probes every connected target (never unconnected ones)', async () => {
    const h = harness([
      target('a'),
      target('b', { credentialRef: null, health: 'unconnected' }),
      target('c', { provider: 'aws', authMethod: 'key', credentialRef: 'styx:v1:aws:c:key' }),
    ]);
    h.scheduler.start();
    h.scheduler.start(); // idempotent
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]?.ms).toBe(30 * MIN);
    h.timers[0]?.fn();
    await h.scheduler.runNow('interval'); // joins the in-flight interval run
    expect(h.calls).toEqual([
      { id: 'a', reason: 'interval' },
      { id: 'c', reason: 'interval' },
    ]);
    h.scheduler.stop();
    expect(h.timers[0]?.cleared).toBe(true);
  });

  it('focus and wake skip targets probed within the last 5 min; interval and manual never skip', async () => {
    const h = harness([
      target('a', { healthCheckedAt: NOW - 2 * MIN }),
      target('b', { healthCheckedAt: NOW - 20 * MIN }),
      target('c'),
    ]);
    await h.scheduler.runNow('focus');
    expect(h.calls.map((c) => c.id)).toEqual(['b', 'c']);
    h.calls.length = 0;
    await h.scheduler.runNow('wake');
    expect(h.calls).toEqual([]); // everything was just probed
    h.clock.advance(6 * MIN);
    await h.scheduler.runNow('wake');
    expect(h.calls.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    h.calls.length = 0;
    await h.scheduler.runNow('manual');
    expect(h.calls.map((c) => `${c.id}:${c.reason}`)).toEqual(['a:manual', 'b:manual', 'c:manual']);
    h.calls.length = 0;
    await h.scheduler.runNow('interval');
    expect(h.calls).toHaveLength(3);
  });

  it('a single target can be refreshed on demand; a failing probe does not stop the others', async () => {
    const h = harness([target('a'), target('b'), target('c')], { failing: 'b' });
    await h.scheduler.runNow('manual', 'b');
    expect(h.calls).toEqual([{ id: 'b', reason: 'manual' }]);
    h.calls.length = 0;
    await h.scheduler.runNow('manual', 'nope');
    expect(h.calls).toEqual([]);
    await expect(h.scheduler.runNow('interval')).resolves.toBeUndefined();
    expect(h.calls.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('concurrent full runs share one promise', async () => {
    const h = harness([target('a'), target('b')]);
    const p1 = h.scheduler.runNow('interval');
    const p2 = h.scheduler.runNow('focus');
    expect(p2).toBe(p1);
    await p1;
    expect(h.calls).toHaveLength(2);
    await h.scheduler.runNow('manual');
    expect(h.calls).toHaveLength(4);
  });
});

import type { UsageEvent } from '@styx/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INSTALL_ID_KEY, installIdFrom, UsageReportService } from './usage-report-service';

/**
 * The usage reporter (discrepancies #114, #122). What matters here is what it refuses to do: send when turned
 * off, hoard what it could not deliver, or carry anything but a name, a count, the install id, version and OS.
 */

const INSTALL = 'inst_abcdefghijklmnopqrstuv';

const setup = (over: { enabled?: boolean; token?: string | null } = {}) => {
  const sent: { url: string; body: unknown; auth: string | null }[] = [];
  let enabled = over.enabled ?? true;
  let token: string | null = over.token === undefined ? 'at-1' : over.token;
  let now = 1_000_000;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? {});
    sent.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? 'null')),
      auth: headers.get('Authorization'),
    });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const service = new UsageReportService({
    fetch: fetchImpl,
    apiBase: () => 'https://api.test/',
    token: async () => token,
    installId: () => INSTALL,
    version: '0.2.6',
    os: 'darwin',
    enabled: () => enabled,
    now: () => now,
  });
  return {
    service,
    sent,
    setEnabled: (v: boolean) => {
      enabled = v;
    },
    setToken: (v: string | null) => {
      token = v;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
};

describe('UsageReportService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('folds repeats into one row and sends name + count and nothing else', async () => {
    const t = setup();
    t.service.record('app.launched');
    t.service.record('agent.spawned');
    t.service.record('app.launched');
    await t.service.flush();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]?.url).toBe('https://api.test/v1/events');
    expect(t.sent[0]?.auth).toBe('Bearer at-1');
    expect(t.sent[0]?.body).toEqual({
      installId: INSTALL,
      version: '0.2.6',
      os: 'darwin',
      events: [
        { name: 'app.launched', at: 1_000_000, count: 2 },
        { name: 'agent.spawned', at: 1_000_000, count: 1 },
      ],
    });
    // Every key on the wire is one of these three; there is nowhere for anything else to ride along.
    const keys = new Set(
      ((t.sent[0]?.body as { events: Record<string, unknown>[] }).events ?? []).flatMap((e) =>
        Object.keys(e),
      ),
    );
    expect([...keys].sort()).toEqual(['at', 'count', 'name']);
    expect(Object.keys(t.sent[0]?.body as object).sort()).toEqual(['events', 'installId', 'os', 'version']);
  });

  it('sends nothing at all when the person turned it off, and keeps nothing either', async () => {
    const t = setup({ enabled: false });
    t.service.record('app.launched');
    await t.service.flush();
    expect(t.sent).toEqual([]);

    // Turned off after recording: the buffer is dropped rather than held until it is turned back on.
    const u = setup();
    u.service.record('app.launched');
    u.setEnabled(false);
    await u.service.flush();
    expect(u.sent).toEqual([]);
    u.setEnabled(true);
    await u.service.flush();
    expect(u.sent).toEqual([]);
  });

  it('signed out, sends under the install id alone, with no token', async () => {
    const t = setup({ token: null });
    t.service.record('app.launched');
    await t.service.flush();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]?.auth).toBeNull();
    expect(t.sent[0]?.body).toMatchObject({ installId: INSTALL, events: [{ name: 'app.launched' }] });
  });

  it('a token that cannot be read is the same as signed out, not a reason to drop the batch', async () => {
    const sent: (string | null)[] = [];
    const service = new UsageReportService({
      fetch: (async (_: unknown, init?: RequestInit) => {
        sent.push(new Headers(init?.headers ?? {}).get('Authorization'));
        return new Response('{}');
      }) as unknown as typeof globalThis.fetch,
      apiBase: () => 'https://api.test',
      token: async () => {
        throw new Error('refresh failed');
      },
      installId: () => INSTALL,
      version: '0.2.6',
      os: 'darwin',
      enabled: () => true,
      now: () => 1,
    });
    service.record('app.launched');
    await service.flush();
    expect(sent).toEqual([null]);
  });

  it('drops a batch the API would not take rather than piling it up', async () => {
    const sent: unknown[] = [];
    const service = new UsageReportService({
      fetch: (async () => {
        sent.push('attempt');
        throw new Error('offline');
      }) as unknown as typeof globalThis.fetch,
      apiBase: () => 'https://api.test',
      token: async () => 'at-1',
      installId: () => INSTALL,
      version: '0.2.6',
      os: 'darwin',
      enabled: () => true,
      now: () => 1,
    });
    service.record('app.launched');
    await service.flush(); // throws inside, swallowed
    expect(sent).toHaveLength(1);
    // Nothing was kept, so the next flush is a no-op rather than a retry.
    await service.flush();
    expect(sent).toHaveLength(1);
  });

  it('flushes on a timer and once more on shutdown', async () => {
    const t = setup();
    t.service.start();
    t.service.record('app.launched');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(t.sent).toHaveLength(1);
    t.service.record('deploy.run');
    await t.service.shutdown();
    expect(t.sent).toHaveLength(2);
    // The timer is gone: nothing fires after shutdown.
    t.service.record('grant.approved');
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(t.sent).toHaveLength(2);
  });

  it('records nothing at all when off, so a later flush has nothing to decide about', async () => {
    const t = setup({ enabled: false });
    for (const name of ['app.launched', 'project.added', 'deploy.run'] as UsageEvent[])
      t.service.record(name);
    t.setEnabled(true);
    await t.service.flush();
    expect(t.sent).toEqual([]);
  });

  it('makes an install id once, keeps it, and replaces one that is not well formed', () => {
    const store = new Map<string, unknown>();
    const kv = {
      get: <T>(k: string) => store.get(k) as T | undefined,
      set: (k: string, v: unknown) => void store.set(k, v),
    };
    const first = installIdFrom(kv);
    expect(first).toMatch(/^inst_[A-Za-z0-9_-]{22}$/);
    expect(installIdFrom(kv)).toBe(first);
    store.set(INSTALL_ID_KEY, 'tampered');
    const second = installIdFrom(kv);
    expect(second).not.toBe(first);
    expect(second).toMatch(/^inst_/);
  });
});

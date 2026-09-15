import { describe, expect, it, vi } from 'vitest';
import { PreviewProbe, type PreviewStatus } from './preview-probe';

const harness = (answers: boolean[]) => {
  const queue = [...answers];
  const ready: string[] = [];
  const statuses: PreviewStatus[] = [];
  const timers: (() => void)[] = [];
  const probe = vi.fn(async () => queue.shift() ?? true);
  const loop = new PreviewProbe({
    probe,
    onReady: (u) => ready.push(u),
    onStatus: (s) => statuses.push(s),
    intervalMs: 1000,
    maxAttempts: 3,
    setTimeout: (fn) => {
      timers.push(fn);
      return 0 as unknown as NodeJS.Timeout;
    },
    clearTimeout: () => undefined,
  });
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  const fire = async () => {
    const fn = timers.shift();
    fn?.();
    await flush();
  };
  return { loop, probe, ready, statuses, timers, flush, fire };
};

describe('PreviewProbe', () => {
  it('loads on the first answer', async () => {
    const h = harness([true]);
    h.loop.start('http://localhost:3000/');
    await h.flush();
    expect(h.ready).toEqual(['http://localhost:3000/']);
    expect(h.statuses).toEqual([{ url: 'http://localhost:3000/', phase: 'loaded', attempts: 1 }]);
    expect(h.timers).toHaveLength(0);
  });

  it('waits while the server is not answering yet, reporting each attempt, then loads', async () => {
    const h = harness([false, false, true]);
    h.loop.start('http://localhost:3000/');
    await h.flush();
    expect(h.statuses.at(-1)).toEqual({ url: 'http://localhost:3000/', phase: 'waiting', attempts: 1 });
    await h.fire();
    expect(h.statuses.at(-1)).toEqual({ url: 'http://localhost:3000/', phase: 'waiting', attempts: 2 });
    await h.fire();
    expect(h.ready).toEqual(['http://localhost:3000/']);
    expect(h.statuses.at(-1)?.phase).toBe('loaded');
  });

  it('gives up after maxAttempts and says so; restart probes again', async () => {
    const h = harness([false, false, false, true]);
    h.loop.start('http://localhost:3000/');
    await h.flush();
    await h.fire();
    await h.fire();
    expect(h.statuses.at(-1)).toEqual({ url: 'http://localhost:3000/', phase: 'failed', attempts: 3 });
    expect(h.ready).toEqual([]);
    h.loop.restart();
    await h.flush();
    expect(h.ready).toEqual(['http://localhost:3000/']);
  });

  it('a new URL abandons the old attempt, and stop drops everything', async () => {
    const pending: { resolve: ((v: boolean) => void) | null } = { resolve: null };
    const probe = vi.fn(
      (url: string) =>
        new Promise<boolean>((resolve) => {
          if (url.includes('3001')) pending.resolve = resolve;
          else resolve(true);
        }),
    );
    const ready: string[] = [];
    const loop = new PreviewProbe({ probe, onReady: (u) => ready.push(u), onStatus: () => undefined });
    loop.start('http://localhost:3001/');
    loop.start('http://localhost:3000/');
    await Promise.resolve();
    await Promise.resolve();
    pending.resolve?.(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(ready).toEqual(['http://localhost:3000/']);
    expect(loop.current()).toBe('http://localhost:3000/');
    loop.reset();
    expect(loop.current()).toBeNull();
  });
});

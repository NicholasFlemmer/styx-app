import { describe, expect, it, vi } from 'vitest';
import { CliWatchService, type DirWatcher, type WatchFn } from './cli-watch-service';

/** A watcher the test fires by hand: which dirs are watched, and a way to raise a change or an error on one. */
function fakeWatch() {
  const open = new Map<string, { cb: () => void; onError: ((e: Error) => void) | null }>();
  const watch: WatchFn = (dir, _opts, cb) => {
    const entry = { cb, onError: null as ((e: Error) => void) | null };
    open.set(dir, entry);
    const w: DirWatcher = {
      on: (_event, handler) => {
        entry.onError = handler;
        return w;
      },
      close: () => {
        open.delete(dir);
      },
    };
    return w;
  };
  return {
    watch,
    dirs: () => [...open.keys()].sort(),
    fire: (dir: string) => open.get(dir)?.cb(),
    fail: (dir: string) => open.get(dir)?.onError?.(new Error('gone')),
  };
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('CliWatchService (#98)', () => {
  it('watches exactly the folders it is given once started, re-detects once per burst, and releases what it is told to', async () => {
    const fw = fakeWatch();
    const onChange = vi.fn(async () => undefined);
    const svc = new CliWatchService({ onChange, debounceMs: 20, watch: fw.watch });
    svc.update(['/a']); // before start nothing is watched
    expect(svc.size).toBe(0);
    svc.start();
    svc.update(['/a', '/b']);
    expect(fw.dirs()).toEqual(['/a', '/b']);
    fw.fire('/a');
    fw.fire('/b');
    fw.fire('/a');
    await settle(60);
    expect(onChange).toHaveBeenCalledTimes(1); // one burst, one re-detect
    svc.update(['/b', '/c']); // a released, c added, b kept
    expect(fw.dirs()).toEqual(['/b', '/c']);
    expect(svc.size).toBe(2);
    fw.fire('/c');
    await settle(60);
    expect(onChange).toHaveBeenCalledTimes(2);
    svc.stop();
    expect(svc.size).toBe(0);
    expect(fw.dirs()).toEqual([]);
  });

  it('a watcher that errors is dropped; a re-detect that throws is logged, never raised into the callback', async () => {
    const fw = fakeWatch();
    const onChange = vi.fn(async () => {
      throw new Error('detect blew up');
    });
    const svc = new CliWatchService({ onChange, debounceMs: 10, watch: fw.watch });
    svc.start();
    svc.update(['/a', '/b']);
    fw.fail('/a');
    expect(fw.dirs()).toEqual(['/b']);
    expect(svc.size).toBe(1);
    fw.fire('/b');
    await settle(40);
    expect(onChange).toHaveBeenCalledTimes(1);
    svc.stop();
  });

  it('a folder that cannot be watched is skipped, not fatal', () => {
    const watch: WatchFn = (dir) => {
      if (dir === '/missing') throw new Error('ENOENT');
      return { on: () => undefined, close: () => undefined };
    };
    const svc = new CliWatchService({ onChange: () => undefined, watch });
    svc.start();
    svc.update(['/ok', '/missing']);
    expect(svc.size).toBe(1);
    svc.stop();
  });
});

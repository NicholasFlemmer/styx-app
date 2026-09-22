import { fixtures } from '@styx/core';
import { describe, expect, it, vi } from 'vitest';
import { makeTestApp } from '../test-support';
import type { FsWatcherLike } from './hunk-service';
import { TreeWatchService } from './tree-watch-service';

const { ids } = fixtures;

/** A watcher the test fires by hand; records what was watched and whether it was closed. */
class FakeWatcher implements FsWatcherLike {
  cb: ((event: string, path: string) => void) | null = null;
  closed = false;
  on(_event: 'all', cb: (event: string, path: string) => void): unknown {
    this.cb = cb;
    return this;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  fire(path: string): void {
    this.cb?.('add', path);
  }
}

describe('TreeWatchService (the files pane follows the disk)', () => {
  it('watches the worktree a window shows, says fs.treeChanged once per burst, swaps watchers and closes them', async () => {
    vi.useFakeTimers();
    try {
      const t = makeTestApp();
      const made: { path: string; watcher: FakeWatcher }[] = [];
      const svc = new TreeWatchService({
        repos: t.app.repos,
        publisher: t.app.publisher,
        watch: async (path) => {
          const watcher = new FakeWatcher();
          made.push({ path, watcher });
          return watcher;
        },
      });
      await svc.watch(1, ids.worktree.fixCheckout);
      expect(made).toHaveLength(1);
      expect(made[0]?.path).toBe(t.app.repos.worktrees.get(ids.worktree.fixCheckout)?.path);
      // The same worktree again is a no-op; a burst of changes is one event after the debounce.
      await svc.watch(1, ids.worktree.fixCheckout);
      expect(made).toHaveLength(1);
      made[0]?.watcher.fire('a.ts');
      made[0]?.watcher.fire('b.ts');
      vi.advanceTimersByTime(300);
      expect(t.win.events('fs.treeChanged')).toEqual([{ worktreeId: ids.worktree.fixCheckout }]);
      // Another worktree for the same window replaces the watcher and closes the old one.
      await svc.watch(1, ids.worktree.acmeMain);
      expect(made).toHaveLength(2);
      expect(made[0]?.watcher.closed).toBe(true);
      await svc.unwatch(1);
      expect(made[1]?.watcher.closed).toBe(true);
      await svc.watch(2, ids.worktree.acmeMain);
      await svc.closeAll();
      expect(made[2]?.watcher.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('chokidarWatch (the real watcher behind hunks and the files pane)', () => {
  it('watches a lane that lives under a .styx folder (every default lane does); .git and node_modules inside stay ignored', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { chokidarWatch } = await import('./hunk-service');
    const root = mkdtempSync(join(tmpdir(), 'styx-watch-'));
    const lane = join(root, '.styx', 'worktrees', 'acme', 'fix-checkout');
    mkdirSync(join(lane, 'node_modules'), { recursive: true });
    const watcher = await chokidarWatch(lane);
    const seen: string[] = [];
    watcher.on('all', (_e, p) => seen.push(p));
    try {
      // chokidar settles its initial scan first; a write after that must be reported.
      await new Promise((r) => setTimeout(r, 400));
      writeFileSync(join(lane, 'new.ts'), 'x\n');
      writeFileSync(join(lane, 'node_modules', 'dep.js'), 'x\n');
      const deadline = Date.now() + 4000;
      while (!seen.some((p) => p.endsWith('new.ts')) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 50));
      expect(seen.some((p) => p.endsWith('new.ts'))).toBe(true);
      expect(seen.some((p) => p.includes('node_modules'))).toBe(false);
    } finally {
      await watcher.close();
    }
  }, 15_000);
});

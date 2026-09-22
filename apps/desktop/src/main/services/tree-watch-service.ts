import type { Repos } from '../db/repos';
import type { Publisher } from '../store/publisher';
import { chokidarWatch, type FsWatcherLike, type WatchFactory } from './hunk-service';
import { logger } from './logger';

const DEBOUNCE_MS = 250;

export interface TreeWatchDeps {
  repos: Repos;
  publisher: Publisher;
  watch?: WatchFactory;
}

/**
 * Watches the worktree the files pane shows and says `fs.treeChanged` (debounced) when anything under it moves —
 * a file an agent wrote mid-turn, one made in Finder, a `git checkout`. Without it the tree was read once per
 * worktree on mount and a new file showed only after leaving and re-entering the Workspace. One watcher per
 * window; the hunk watcher's ignore list (.git, node_modules, .styx) keeps it cheap.
 */
export class TreeWatchService {
  private readonly watchers = new Map<
    number,
    { worktreeId: string; watcher: FsWatcherLike; timer: NodeJS.Timeout | null }
  >();

  constructor(private readonly deps: TreeWatchDeps) {}

  async watch(windowId: number, worktreeId: string): Promise<void> {
    const current = this.watchers.get(windowId);
    if (current?.worktreeId === worktreeId) return;
    await this.unwatch(windowId);
    const wt = this.deps.repos.worktrees.get(worktreeId);
    if (!wt) return;
    try {
      const watcher = await (this.deps.watch ?? chokidarWatch)(wt.path);
      const entry = { worktreeId, watcher, timer: null as NodeJS.Timeout | null };
      watcher.on('all', () => {
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          entry.timer = null;
          this.deps.publisher.sendEvent('fs.treeChanged', { worktreeId: wt.id });
        }, DEBOUNCE_MS);
        entry.timer.unref?.();
      });
      this.watchers.set(windowId, entry);
    } catch (e) {
      logger.warn('tree watch: watcher failed', { worktree: wt.path, error: (e as Error).message });
    }
  }

  async unwatch(windowId: number): Promise<void> {
    const w = this.watchers.get(windowId);
    if (!w) return;
    this.watchers.delete(windowId);
    if (w.timer) clearTimeout(w.timer);
    await w.watcher.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.watchers.keys()]) await this.unwatch(id);
  }
}

import {
  newId,
  parseUnifiedDiff,
  type AgentChange,
  type Session,
  type SessionId,
  type Worktree,
  type WorktreeId,
} from '@styx/core';
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import { fail } from '../ipc/bus';
import type { Publisher } from '../store/publisher';
import type { GitService } from './git';
import { logger } from './logger';

export const HUNK_DEBOUNCE_MS = 300;

export interface FsWatcherLike {
  on(event: 'all', cb: (event: string, path: string) => void): unknown;
  close(): Promise<void>;
}

export type WatchFactory = (path: string) => Promise<FsWatcherLike>;

/** chokidar@5 (ESM) is loaded lazily so tests can inject a fake watcher. */
export const chokidarWatch: WatchFactory = async (path) => {
  const { watch } = await import('chokidar');
  return watch(path, {
    ignored: (p: string) => /(^|[\\/])(\.git|node_modules|\.styx)([\\/]|$)/.test(p),
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  }) as unknown as FsWatcherLike;
};

export interface HunkServiceDeps {
  repos: Repos;
  publisher: Publisher;
  clock: Clock;
  git: GitService;
  watch?: WatchFactory;
}

/**
 * Attribution = worktree ownership (plan §5 HunkService): a chokidar watcher per agent worktree, 300 ms debounce,
 * `git diff -U3 <base_commit>` (+ untracked) parsed with core `parseUnifiedDiff`, upserted by content hash.
 */
export class HunkService {
  private readonly watchers = new Map<
    string,
    { watcher: FsWatcherLike; sessionId: SessionId; timer: NodeJS.Timeout | null }
  >();
  private readonly scanning = new Set<string>();
  private readonly dirty = new Set<string>();

  constructor(private readonly deps: HunkServiceDeps) {}

  async watch(session: Session, worktree: Worktree): Promise<void> {
    if (worktree.isMain || this.watchers.has(worktree.id)) return;
    try {
      const watcher = await (this.deps.watch ?? chokidarWatch)(worktree.path);
      const entry = { watcher, sessionId: session.id, timer: null as NodeJS.Timeout | null };
      watcher.on('all', () => this.schedule(worktree.id));
      this.watchers.set(worktree.id, entry);
    } catch (e) {
      logger.warn('hunks: watcher failed', { worktree: worktree.path, error: (e as Error).message });
    }
  }

  async unwatch(worktreeId: WorktreeId | string): Promise<void> {
    const w = this.watchers.get(worktreeId);
    if (!w) return;
    this.watchers.delete(worktreeId);
    if (w.timer) clearTimeout(w.timer);
    await w.watcher.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.watchers.keys()]) await this.unwatch(id);
  }

  private schedule(worktreeId: string): void {
    const w = this.watchers.get(worktreeId);
    if (!w) return;
    if (w.timer) clearTimeout(w.timer);
    w.timer = setTimeout(() => {
      w.timer = null;
      void this.rescanWorktree(worktreeId);
    }, HUNK_DEBOUNCE_MS);
    w.timer.unref?.();
  }

  async rescan(sessionId: string): Promise<AgentChange[]> {
    const s = this.deps.repos.sessions.get(sessionId) ?? fail('not-found', `session ${sessionId} not found`);
    await this.rescanWorktree(s.worktreeId, s.id);
    return this.deps.repos.agentChanges.bySession(s.id);
  }

  private async rescanWorktree(worktreeId: string, sessionIdHint?: string): Promise<void> {
    if (this.scanning.has(worktreeId)) {
      this.dirty.add(worktreeId);
      return;
    }
    this.scanning.add(worktreeId);
    try {
      const { repos, publisher, git, clock } = this.deps;
      const worktree = repos.worktrees.get(worktreeId);
      if (!worktree) return;
      const sessionId = (sessionIdHint ??
        (worktree.owner.kind === 'session'
          ? worktree.owner.sessionId
          : this.watchers.get(worktreeId)?.sessionId)) as SessionId | undefined;
      if (!sessionId) return;
      const base = worktree.baseCommit ?? 'HEAD';
      let text = '';
      try {
        text = await git.diffWithUntracked(worktree.path, base);
      } catch (e) {
        logger.warn('hunks: diff failed', { worktree: worktree.path, error: (e as Error).message });
        return;
      }
      const diff = parseUnifiedDiff(text);
      const now = clock.now();
      const seen = new Set<string>();
      const existing = repos.agentChanges.byWorktree(worktree.id);
      repos.transaction(() => {
        for (const file of diff.files) {
          for (const h of file.hunks) {
            seen.add(h.hunkHash);
            const prev = existing.find((c) => c.hunkHash === h.hunkHash);
            if (prev) {
              repos.agentChanges.upsert({
                ...prev,
                oldStart: h.oldStart,
                oldLines: h.oldLines,
                newStart: h.newStart,
                newLines: h.newLines,
                patch: h.patch,
                lastSeenAt: now,
                status: prev.status === 'stale' ? 'pending' : prev.status,
              });
            } else {
              repos.agentChanges.upsert({
                id: newId<'HunkId'>(),
                sessionId,
                worktreeId: worktree.id,
                file: h.file,
                hunkHash: h.hunkHash,
                oldStart: h.oldStart,
                oldLines: h.oldLines,
                newStart: h.newStart,
                newLines: h.newLines,
                patch: h.patch,
                status: 'pending',
                firstSeenAt: now,
                lastSeenAt: now,
                decidedAt: null,
              });
            }
          }
        }
        for (const c of existing) {
          if (!seen.has(c.hunkHash) && c.status === 'pending')
            repos.agentChanges.upsert({ ...c, status: 'stale' });
        }
        let added = 0;
        let removed = 0;
        for (const f of diff.files) {
          added += f.added;
          removed += f.removed;
        }
        repos.worktrees.upsert({ ...worktree, changes: { added, removed, files: diff.files.length } });
      });
      const hunks = repos.agentChanges.bySession(sessionId);
      publisher.hunksReplace(sessionId, hunks);
      publisher.upsert('worktrees', [worktree.id]);
      publisher.sendEvent('hunks.changed', {
        sessionId,
        worktreeId: worktree.id,
        pending: hunks.filter((h) => h.status === 'pending').length,
      });
    } finally {
      this.scanning.delete(worktreeId);
      if (this.dirty.delete(worktreeId)) void this.rescanWorktree(worktreeId, sessionIdHint);
    }
  }

  private requireHunk(id: string): { hunk: AgentChange; worktree: Worktree } {
    const hunk = this.deps.repos.agentChanges.get(id) ?? fail('not-found', `hunk ${id} not found`);
    const worktree =
      this.deps.repos.worktrees.get(hunk.worktreeId) ?? fail('not-found', 'worktree not found');
    return { hunk, worktree };
  }

  /** Accept = stage this hunk (`git apply --cached`); the working tree is untouched. */
  async accept(hunkId: string): Promise<void> {
    const { hunk, worktree } = this.requireHunk(hunkId);
    if (hunk.status !== 'pending') fail('invalid-transition', `hunk is ${hunk.status}`);
    await this.deps.git.applyPatch(worktree.path, hunk.patch, { cached: true });
    this.decide(hunk, 'accepted');
  }

  /** Reject = reverse-apply in the working tree (`git apply -R`), then rescan. */
  async reject(hunkId: string): Promise<void> {
    const { hunk, worktree } = this.requireHunk(hunkId);
    if (hunk.status !== 'pending') fail('invalid-transition', `hunk is ${hunk.status}`);
    await this.deps.git.applyPatch(worktree.path, hunk.patch, { reverse: true });
    this.decide(hunk, 'rejected');
    await this.rescanWorktree(worktree.id, hunk.sessionId);
  }

  async acceptAll(sessionId: string): Promise<number> {
    let n = 0;
    for (const h of this.deps.repos.agentChanges.bySession(sessionId)) {
      if (h.status !== 'pending') continue;
      await this.accept(h.id);
      n += 1;
    }
    return n;
  }

  async rejectAll(sessionId: string): Promise<number> {
    let n = 0;
    for (const h of this.deps.repos.agentChanges.bySession(sessionId)) {
      if (h.status !== 'pending') continue;
      await this.reject(h.id);
      n += 1;
    }
    return n;
  }

  /** Done = accepted stay staged, pending stay unstaged; returns how many were applied. */
  done(sessionId: string): number {
    return this.deps.repos.agentChanges.bySession(sessionId).filter((h) => h.status === 'accepted').length;
  }

  private decide(hunk: AgentChange, status: 'accepted' | 'rejected'): void {
    const { repos, publisher, clock } = this.deps;
    repos.agentChanges.upsert({ ...hunk, status, decidedAt: clock.now() });
    const hunks = repos.agentChanges.bySession(hunk.sessionId);
    publisher.hunksReplace(hunk.sessionId, hunks);
    publisher.sendEvent('hunks.changed', {
      sessionId: hunk.sessionId,
      worktreeId: hunk.worktreeId,
      pending: hunks.filter((h) => h.status === 'pending').length,
    });
  }
}

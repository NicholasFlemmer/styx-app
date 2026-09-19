import { copy, fill, type ProjectId, type Worktree, type WorktreeConflict } from '@styx/core';
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import { fail } from '../ipc/bus';
import type { Publisher } from '../store/publisher';
import { projectSettingsFor } from '../store/projection';
import type { ActivityService } from './activity-service';
import type { GitService } from './git';
import { logger } from './logger';
import type { TranscriptService } from './transcript-service';

export interface LaneSyncDeps {
  repos: Repos;
  git: GitService;
  publisher: Publisher;
  clock: Clock;
  transcript: TranscriptService;
  activity: ActivityService;
  /** SessionService.applyEvent: pause the owner on a conflict, resume it once the lane is clean again. */
  sessionEvent: (sessionId: string, event: { type: 'error'; reason: 'conflict' } | { type: 'resolve' }) => void;
  /** `ProjectSettings.autoSync` (ADR-0025): whether a turn boundary brings the base in by itself. */
  autoSyncOf?: (projectId: string) => 'turn' | 'publish' | 'off';
  /** The lane ledger: a project's lanes were re-read / a lane's tree changed under a merge. */
  onRefreshed?: (projectId: string) => void;
  onSynced?: (worktreeId: string) => void;
  /** ADR-0025 phase B: `ProjectSettings.integration`, and the resolver a conflicting merge is handed to in auto mode. */
  integrationOf?: (projectId: string) => 'auto' | 'review';
  resolveConflict?: (worktreeId: string) => Promise<unknown>;
}

export interface SyncResult {
  /** Commits merged in from the base branch; 0 when the lane was already current or the merge conflicted. */
  merged: number;
  conflict: WorktreeConflict | null;
}

const AGENT_LABEL: Record<string, string> = copy.agentProducts;

/**
 * Keep lanes current (ADR-0023). Every lane knows how far behind the project's base branch it is (`behindBase`,
 * refreshed on fetch, focus and wake); a lane can bring the base in on demand (`worktree.sync`), Publish does it
 * before pushing, and a session's chat is told when the base moves. A conflicting merge is undone on the spot, the
 * lane is marked (the existing conflict state) and its session pauses, exactly as a detected conflict does today.
 */
export class LaneSyncService {
  constructor(private readonly deps: LaneSyncDeps) {}

  /** The branch lanes are measured against: the project's `baseBranch` setting, else the repo's default branch. */
  baseOf(projectId: string): string {
    const repo = this.deps.repos.repos.byProject(projectId);
    return projectSettingsFor(this.deps.repos, projectId).baseBranch.value || repo?.defaultBranch || 'main';
  }

  /**
   * Fetch, then refresh the main worktree's ahead/behind against its upstream and every lane's `behindBase` and
   * conflict state against the base branch. Sessions whose lane fell further behind get one system line.
   */
  async refresh(projectId: string): Promise<{ ahead: number; behind: number }> {
    const { repos, git, publisher, clock } = this.deps;
    const project = repos.projects.get(projectId) ?? fail('not-found', `project ${projectId} not found`);
    const repo = repos.repos.byProject(project.id) ?? fail('not-found', 'project has no repo');
    if (repo.defaultBranch === null) return { ahead: 0, behind: 0 }; // plain folder: nothing to fetch
    if ((await git.remotes(project.path)).length > 0) await git.fetch(project.path);
    const status = await git.status(project.path);
    const ab = status.upstream
      ? await git.aheadBehind(project.path, status.branch, status.upstream)
      : { ahead: status.ahead, behind: status.behind };
    repos.repos.upsert({ ...repo, ahead: ab.ahead, behind: ab.behind, fetchedAt: clock.now() });
    publisher.upsert('repos', [repo.id]);

    const base = this.baseOf(project.id);
    const ids: string[] = [];
    for (const wt of repos.worktrees.byProject(project.id)) {
      if (wt.isMain || wt.archivedAt !== null || wt.branch === null) continue;
      const behind = (await git.aheadBehind(project.path, wt.branch, base).catch(() => null))?.behind ?? wt.behindBase;
      const conflict = await git.detectConflict(project.path, wt.branch, base).catch(() => null);
      const conflictChanged = (conflict?.file ?? null) !== (wt.conflict?.file ?? null);
      if (!conflictChanged && behind === wt.behindBase) continue;
      repos.worktrees.upsert({ ...wt, conflict, behindBase: behind });
      ids.push(wt.id);
      const owner = wt.owner.kind === 'session' ? repos.sessions.get(wt.owner.sessionId) : null;
      if (owner !== null && owner.state !== 'done') {
        if (conflictChanged && conflict) this.deps.sessionEvent(owner.id, { type: 'error', reason: 'conflict' });
        if (conflictChanged && !conflict && owner.state === 'paused' && owner.pausedReason === 'conflict')
          this.deps.sessionEvent(owner.id, { type: 'resolve' });
        if (behind > wt.behindBase)
          this.deps.transcript.system(owner.id, fill(copy.sync.baseMoved, { base, n: behind - wt.behindBase }));
      }
    }
    publisher.upsert('worktrees', ids);
    this.deps.onRefreshed?.(project.id);
    return ab;
  }

  /**
   * Brings the base in on its own at a turn boundary (`autoSync: 'turn'`, ADR-0025): the agent has just gone
   * quiet, so nothing lands under a write, and small frequent merges are what keeps conflicts rare. A lane that
   * is current is left alone; one that would conflict is marked as `refresh` marks it and left for the resolution
   * flow — an automatic merge never leaves markers behind.
   */
  async autoSync(sessionId: string): Promise<void> {
    const { repos, git } = this.deps;
    const session = repos.sessions.get(sessionId);
    if (!session || session.purpose) return;
    const wt = repos.worktrees.get(session.worktreeId);
    if (!wt || wt.isMain || wt.archivedAt !== null || wt.branch === null || wt.conflict !== null) return;
    if (wt.resolution !== null && (wt.resolution.state === 'resolving' || wt.resolution.state === 'checking')) return;
    if ((this.deps.autoSyncOf?.(wt.projectId) ?? 'turn') !== 'turn') return;
    const project = repos.projects.get(wt.projectId);
    if (!project) return;
    const base = this.baseOf(project.id);
    const behind = (await git.aheadBehind(project.path, wt.branch, base).catch(() => null))?.behind ?? 0;
    if (behind === 0) return;
    const conflict = await git.detectConflict(project.path, wt.branch, base).catch(() => null);
    if (conflict !== null) {
      // Auto: Styx finishes the merge with the agent (ADR-0025 phase B). Review: mark it and say how to ask.
      if ((this.deps.integrationOf?.(wt.projectId) ?? 'auto') === 'auto' && this.deps.resolveConflict) {
        await this.deps.resolveConflict(wt.id);
        return;
      }
      this.save({ ...wt, conflict, behindBase: behind });
      this.deps.transcript.system(
        session.id,
        fill(copy.sync.conflictReview, { base, file: conflict.file, agent: AGENT_LABEL[session.agent] ?? session.agent }),
      );
      if (session.state !== 'paused') this.deps.sessionEvent(session.id, { type: 'error', reason: 'conflict' });
      return;
    }
    const r = await this.sync(wt.id);
    if (r.merged > 0) this.deps.transcript.system(session.id, fill(copy.sync.autoSynced, { base, n: r.merged }));
  }

  /** Every git project, for the refresh scheduler (focus / wake / manual). Never throws. */
  async refreshAll(): Promise<void> {
    for (const project of this.deps.repos.projects.all()) {
      if (project.removedAt !== null) continue;
      try {
        await this.refresh(project.id);
      } catch (e) {
        logger.warn('lane sync: refresh failed', { projectId: project.id, error: (e as Error).message });
      }
    }
  }

  /**
   * Merge the base branch into a lane. Refuses while the owning agent is mid-turn (it may be writing files).
   * On conflict the merge is aborted so the tree is left exactly as it was, the lane is marked and the session
   * pauses; the chat gets the reason either way.
   */
  async sync(worktreeId: string): Promise<SyncResult> {
    const { repos, git, publisher } = this.deps;
    const wt = repos.worktrees.get(worktreeId) ?? fail('not-found', `worktree ${worktreeId} not found`);
    if (wt.isMain) fail('invalid-input', 'the main worktree is the base; nothing to bring in');
    if (wt.archivedAt !== null) fail('invalid-input', 'the lane is archived');
    const branch = wt.branch ?? fail('invalid-input', copy.publish.noBranch);
    const project = repos.projects.get(wt.projectId) ?? fail('not-found', 'project not found');
    const base = this.baseOf(project.id);
    const owner = wt.owner.kind === 'session' ? repos.sessions.get(wt.owner.sessionId) : null;
    const live = owner !== null && owner.state !== 'done' ? owner : null;
    if (live !== null && live.state === 'working')
      fail('invalid-input', fill(copy.sync.busy, { agent: AGENT_LABEL[live.agent] ?? live.agent, base }));

    if ((await git.remotes(project.path)).length > 0) await git.fetch(project.path).catch(() => undefined);
    const behind = (await git.aheadBehind(project.path, branch, base)).behind;
    if (behind === 0) {
      if (wt.behindBase !== 0) this.save({ ...wt, behindBase: 0 });
      if (live !== null) this.deps.transcript.system(live.id, fill(copy.sync.upToDate, { base }));
      return { merged: 0, conflict: null };
    }

    const r = await git.merge(wt.path, base);
    if (!r.ok) {
      const status = await git.status(wt.path).catch(() => null);
      const file = status?.changed.find((c) => c.kind === 'conflict')?.path ?? null;
      await git.mergeAbort(wt.path);
      if (file === null) fail('git-error', r.output || `git merge ${base} failed`);
      const conflict: WorktreeConflict = { file, against: base };
      this.save({ ...wt, conflict, behindBase: behind });
      if (live !== null) {
        this.deps.transcript.system(live.id, fill(copy.sync.conflict, { base, file }));
        if (live.state !== 'paused') this.deps.sessionEvent(live.id, { type: 'error', reason: 'conflict' });
      }
      logger.info('lane sync: conflict', { branch, base, file });
      // Auto mode: the resolver takes it from here (its own merge, checkpointed, handed to the agent).
      if ((this.deps.integrationOf?.(wt.projectId) ?? 'auto') === 'auto' && this.deps.resolveConflict)
        void this.deps.resolveConflict(wt.id).catch((e: Error) =>
          logger.warn('lane sync: resolve after conflict failed', { branch, error: e.message }),
        );
      return { merged: 0, conflict };
    }

    const head = await git.headCommit(wt.path);
    this.save({ ...wt, headCommit: head, conflict: null, behindBase: 0 });
    if (live !== null) {
      this.deps.transcript.system(live.id, fill(copy.sync.synced, { base, n: behind }));
      if (live.state === 'paused' && live.pausedReason === 'conflict') this.deps.sessionEvent(live.id, { type: 'resolve' });
    }
    this.deps.activity.append({
      who: 'you',
      what: `${project.name} · ${fill(copy.sync.activity, { base, branch, n: behind })}`,
      projectId: project.id as ProjectId,
      sessionId: live?.id ?? null,
    });
    publisher.upsert('worktrees', [wt.id]);
    this.deps.onSynced?.(wt.id);
    logger.info('lane sync: merged', { branch, base, commits: behind });
    return { merged: behind, conflict: null };
  }

  private save(wt: Worktree): void {
    this.deps.repos.worktrees.upsert(wt);
    this.deps.publisher.upsert('worktrees', [wt.id]);
  }
}

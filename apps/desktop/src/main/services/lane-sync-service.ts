import { copy, fill, type ProjectId, type Worktree, type WorktreeConflict } from '@styx/core';
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import { fail } from '../ipc/bus';
import type { Publisher } from '../store/publisher';
import { projectSettingsFor } from '../store/projection';
import type { ActivityService } from './activity-service';
import { blockingChanges, type GitService } from './git';
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
  sessionEvent: (
    sessionId: string,
    event: { type: 'error'; reason: 'conflict' } | { type: 'resolve' },
  ) => void;
  /** `ProjectSettings.autoSync` (ADR-0025): whether a turn boundary brings the base in by itself. */
  autoSyncOf?: (projectId: string) => 'turn' | 'publish' | 'off';
  /** The lane ledger: a project's lanes were re-read / a lane's tree changed under a merge. */
  onRefreshed?: (projectId: string) => void;
  onSynced?: (worktreeId: string) => void;
  /** ADR-0025 phase B: `ProjectSettings.integration`, and the resolver a conflicting merge is handed to in auto mode. */
  integrationOf?: (projectId: string) => 'auto' | 'review';
  resolveConflict?: (worktreeId: string) => Promise<unknown>;
  /**
   * Commits what the lane left uncommitted before a merge (PublishService, `through: 'commit'`: by name, secret
   * files stay out). git refuses to merge over local changes to a file the merge touches, and a raw
   * "would be overwritten" error is no answer to a person who pressed Bring in main. Absent = merge as is.
   */
  commitLane?: (worktreeId: string, message: string) => Promise<string | null>;
}

export interface SyncResult {
  /** Commits merged in from the base branch; 0 when the lane was already current or the merge conflicted. */
  merged: number;
  conflict: WorktreeConflict | null;
}

/**
 * What became of the local base after a fetch (ADR-0023, closed): `forwarded` = it now equals its upstream;
 * `current` = it already did; `stale` = upstream is ahead but the local branch could not be moved (the main folder
 * has uncommitted changes, or the base is checked out somewhere else), so lanes are measured against the upstream
 * ref instead; `diverged` = local commits the upstream lacks and vice versa — the person's to sort out, nothing is
 * moved and lanes keep measuring against the local branch (which is what would be pushed).
 */
export type FreshenResult =
  | { state: 'no-remote' | 'no-upstream' | 'current' }
  | { state: 'forwarded'; commits: number; upstream: string }
  | { state: 'stale'; reason: 'dirty' | 'checked-out' | 'failed'; behind: number; upstream: string }
  | { state: 'diverged'; ahead: number; behind: number; upstream: string };

const AGENT_LABEL: Record<string, string> = copy.agentProducts;

/**
 * Keep lanes current (ADR-0023). Every lane knows how far behind the project's base branch it is (`behindBase`,
 * refreshed on fetch, focus and wake); a lane can bring the base in on demand (`worktree.sync`), Publish does it
 * before pushing, and a session's chat is told when the base moves. A conflicting merge is undone on the spot, the
 * lane is marked (the existing conflict state) and its session pauses, exactly as a detected conflict does today.
 */
export class LaneSyncService {
  /** Per project: the upstream ref lanes measure against while the local base cannot be brought up to it. */
  private readonly staleUpstream = new Map<string, string>();

  constructor(private readonly deps: LaneSyncDeps) {}

  /** The branch lanes are measured against: the project's `baseBranch` setting, else the repo's default branch. */
  baseOf(projectId: string): string {
    const repo = this.deps.repos.repos.byProject(projectId);
    return projectSettingsFor(this.deps.repos, projectId).baseBranch.value || repo?.defaultBranch || 'main';
  }

  /**
   * The ref lanes are diffed against and merge from: the base branch, or its upstream (`origin/main`) for as long
   * as the local branch is behind it and cannot be moved (`freshenBase`). Nothing is ever measured against a base
   * that fetch has already shown to be stale.
   */
  baseRefOf(projectId: string): string {
    return this.staleUpstream.get(projectId) ?? this.baseOf(projectId);
  }

  /**
   * Brings the local base branch up to its upstream after a fetch. A fetch updates `origin/main`, never `main`:
   * without this every "behind" count, "already up to date" line, sync and landing measured against whatever the
   * main folder last pulled — 77 commits stale, on one project. A fast-forward is the only move ever made: in the
   * main folder when it is on the base and clean, by ref when the base is checked out nowhere; a dirty folder or
   * a diverged branch is left exactly as it is, and the person sees it on the Repo row (main's ↑/↓).
   */
  async freshenBase(projectId: string): Promise<FreshenResult> {
    const { repos, git } = this.deps;
    const project = repos.projects.get(projectId) ?? fail('not-found', `project ${projectId} not found`);
    const base = this.baseOf(projectId);
    const done = (r: FreshenResult): FreshenResult => {
      if (r.state === 'stale') this.staleUpstream.set(projectId, r.upstream);
      else this.staleUpstream.delete(projectId);
      return r;
    };
    if ((await git.remotes(project.path)).length === 0) return done({ state: 'no-remote' });
    const upstream = await git.upstreamRef(project.path, base);
    if (upstream === null) return done({ state: 'no-upstream' });
    const [local, remote] = await Promise.all([
      git.revParse(project.path, base),
      git.revParse(project.path, upstream),
    ]);
    if (local === null || remote === null) return done({ state: 'no-upstream' });
    if (local === remote) return done({ state: 'current' });
    const { ahead, behind } = await git.aheadBehind(project.path, base, upstream);
    if (ahead > 0) return done({ state: 'diverged', ahead, behind, upstream });
    // Behind only: a fast-forward. In the main folder when it is on the base; by ref when the base is checked out
    // nowhere (the folder is on another branch); never under a dirty tree or a checkout elsewhere.
    const current = await git.currentBranch(project.path);
    if (current === base) {
      // Tracked changes block the move; an untracked file or Styx's own `.styx/project.json` does not (a
      // fast-forward leaves them alone, and one the incoming commits would overwrite makes git refuse, which
      // reads as `failed` below).
      const status = await git.status(project.path);
      if (blockingChanges(status).length > 0)
        return done({ state: 'stale', reason: 'dirty', behind, upstream });
      const ok = await git.mergeFfOnly(project.path, upstream);
      if (!ok) return done({ state: 'stale', reason: 'failed', behind, upstream });
    } else {
      const elsewhere = (await git.worktreeList(project.path).catch(() => [])).some((w) => w.branch === base);
      if (elsewhere) return done({ state: 'stale', reason: 'checked-out', behind, upstream });
      await git.updateBranchRef(project.path, base, remote);
    }
    logger.info('lane sync: base forwarded', { base, upstream, commits: behind });
    return done({ state: 'forwarded', commits: behind, upstream });
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
    // The remotes are read again on every fetch: a remote added or removed outside Styx must not leave the Repo
    // header (and Publish's no-remote notice) describing a remote git no longer has.
    const remotes = (await git.remotes(project.path)).map((r) => ({ name: r.name, url: r.url }));
    if (remotes.length > 0) await git.fetch(project.path);
    const status = await git.status(project.path);
    const ab = status.upstream
      ? await git.aheadBehind(project.path, status.branch, status.upstream)
      : { ahead: status.ahead, behind: status.behind };
    repos.repos.upsert({ ...repo, remotes, ahead: ab.ahead, behind: ab.behind, fetchedAt: clock.now() });
    publisher.upsert('repos', [repo.id]);

    await this.freshenBase(project.id).catch((e: Error) =>
      logger.warn('lane sync: could not freshen the base', { projectId: project.id, error: e.message }),
    );
    const base = this.baseRefOf(project.id);
    const ids: string[] = [];
    for (const wt of repos.worktrees.byProject(project.id)) {
      if (wt.isMain || wt.archivedAt !== null || wt.branch === null) continue;
      const behind =
        (await git.aheadBehind(project.path, wt.branch, base).catch(() => null))?.behind ?? wt.behindBase;
      const conflict = await git.detectConflict(project.path, wt.branch, base).catch(() => null);
      const conflictChanged = (conflict?.file ?? null) !== (wt.conflict?.file ?? null);
      if (!conflictChanged && behind === wt.behindBase) continue;
      repos.worktrees.upsert({ ...wt, conflict, behindBase: behind });
      ids.push(wt.id);
      const owner = wt.owner.kind === 'session' ? repos.sessions.get(wt.owner.sessionId) : null;
      if (owner !== null && owner.state !== 'done') {
        if (conflictChanged && conflict)
          this.deps.sessionEvent(owner.id, { type: 'error', reason: 'conflict' });
        if (conflictChanged && !conflict && owner.state === 'paused' && owner.pausedReason === 'conflict')
          this.deps.sessionEvent(owner.id, { type: 'resolve' });
        if (behind > wt.behindBase)
          this.deps.transcript.system(
            owner.id,
            fill(copy.sync.baseMoved, { base, n: behind - wt.behindBase }),
          );
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
    if (wt.resolution !== null && (wt.resolution.state === 'resolving' || wt.resolution.state === 'checking'))
      return;
    if ((this.deps.autoSyncOf?.(wt.projectId) ?? 'turn') !== 'turn') return;
    const project = repos.projects.get(wt.projectId);
    if (!project) return;
    await this.freshenBase(project.id).catch(() => undefined);
    const base = this.baseRefOf(project.id);
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
        fill(copy.sync.conflictReview, {
          base,
          file: conflict.file,
          agent: AGENT_LABEL[session.agent] ?? session.agent,
        }),
      );
      if (session.state !== 'paused')
        this.deps.sessionEvent(session.id, { type: 'error', reason: 'conflict' });
      return;
    }
    const r = await this.sync(wt.id);
    if (r.merged > 0)
      this.deps.transcript.system(session.id, fill(copy.sync.autoSynced, { base, n: r.merged }));
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
    await this.freshenBase(project.id).catch(() => undefined);
    // What the lane merges from: the base, or its upstream while the local base cannot be moved. The words stay
    // `main` either way — that is what the person calls it.
    const baseRef = this.baseRefOf(project.id);
    const behind = (await git.aheadBehind(project.path, branch, baseRef)).behind;
    if (behind === 0) {
      if (wt.behindBase !== 0) this.save({ ...wt, behindBase: 0 });
      if (live !== null) this.deps.transcript.system(live.id, fill(copy.sync.upToDate, { base }));
      return { merged: 0, conflict: null };
    }

    if (this.deps.commitLane !== undefined && !(await git.status(wt.path)).clean)
      await this.deps.commitLane(wt.id, fill(copy.sync.wipCommit, { branch, base }));
    const r = await git.merge(wt.path, baseRef);
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
        void this.deps
          .resolveConflict(wt.id)
          .catch((e: Error) =>
            logger.warn('lane sync: resolve after conflict failed', { branch, error: e.message }),
          );
      return { merged: 0, conflict };
    }

    const head = await git.headCommit(wt.path);
    this.save({ ...wt, headCommit: head, conflict: null, behindBase: 0 });
    if (live !== null) {
      this.deps.transcript.system(live.id, fill(copy.sync.synced, { base, n: behind }));
      if (live.state === 'paused' && live.pausedReason === 'conflict')
        this.deps.sessionEvent(live.id, { type: 'resolve' });
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

  /** Writes only the fields this service owns onto the row as it is now (ADR-0025: other services write theirs). */
  private save(wt: Worktree): void {
    const current = this.deps.repos.worktrees.get(wt.id) ?? wt;
    this.deps.repos.worktrees.upsert({
      ...current,
      headCommit: wt.headCommit,
      conflict: wt.conflict,
      behindBase: wt.behindBase,
    });
    this.deps.publisher.upsert('worktrees', [wt.id]);
  }
}

import {
  copy,
  fill,
  taskOf,
  type Agent,
  type Effort,
  type PermissionMode,
  type Session,
  type SessionId,
  type Worktree,
  type WorktreeResolution,
} from '@styx/core';
import { execa } from 'execa';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import { fail } from '../ipc/bus';
import { STRIPPED_ENV } from '../providers/cli-runner';
import type { Publisher } from '../store/publisher';
import type { ActivityService } from './activity-service';
import { findOnPath } from './detect-service';
import type { GitService } from './git';
import { logger } from './logger';
import type { SessionService } from './session-service';
import type { TranscriptService } from './transcript-service';

export interface ChecksResult {
  exitCode: number;
  /** The tail of stdout + stderr, for the agent's retry and the human's failure line. */
  output: string;
}

export interface ResolveSettings {
  integration: 'auto' | 'review';
  checksCommand: string | null;
  defaultAgent: Agent;
  model: string | null;
  permissionMode: PermissionMode;
  /** The mode a hidden merge task runs in (`ProjectSettings.taskPermissionMode`): bypass by default. */
  taskPermissionMode: PermissionMode;
  effort: Effort | null;
  notifyWhenNeedsMe: boolean;
}

export interface MergeResolveDeps {
  repos: Repos;
  git: GitService;
  publisher: Publisher;
  clock: Clock;
  transcript: TranscriptService;
  activity: ActivityService;
  /** Commits the lane's uncommitted work before the merge (as Land and Bring in main do); absent = merge as is. */
  commitLane?: (worktreeId: string, message: string) => Promise<string | null>;
  /** Checkpoints (ADR-0020): a commit of the working tree before the merge, and writing it back for Undo. */
  checkpoints: {
    capture(worktreePath: string): Promise<string>;
    restoreTree(worktreePath: string, rev: string): Promise<void>;
  };
  sessions: Pick<SessionService, 'get' | 'isRunning' | 'sendMessage' | 'applyEvent' | 'start' | 'interrupt'>;
  ledger: { laneChanged(worktreeId: string): Promise<void> };
  baseOf: (projectId: string) => string;
  settingsOf: (projectId: string) => ResolveSettings;
  /** Runs the project's checks command in the lane; the production runner uses the login shell. */
  runChecks: (cwd: string, command: string) => Promise<ChecksResult>;
  /** Mergiraf's `solve` on one conflicted file when the tool is installed; resolves to whether it was fully solved. */
  mergiraf?: (file: string, cwd: string) => Promise<boolean>;
  /** Waits between retries when git is locked by another process; instant in tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** How many turns the agent gets before the merge is undone and the lane left as it was. */
export const MAX_ATTEMPTS = 2;
/**
 * git refuses while another git process holds the index or a ref (an agent's own `git status`, a checkpoint, an
 * editor). That is a moment's wait, not a failed merge: verify is tried again after each of these delays.
 */
const LOCKED = /index\.lock|cannot lock ref|unable to create '[^']*\.lock'/i;
export const LOCK_RETRY_MS: readonly number[] = [250, 1000, 3000];
const OUTPUT_TAIL = 4000;
const LIST_MAX = 3;
const CHECKS_TIMEOUT_MS = 15 * 60_000;

/**
 * Styx finishes the merge (ADR-0025 phase B). A base merge that conflicts is not abandoned: the lane is
 * checkpointed, the merge is left in progress, what Mergiraf can settle mechanically is settled, and the rest goes
 * to the lane's own agent — or, when that agent is gone, a hidden `merge` task with the project's default agent —
 * as a Styx-authored turn that names every conflicted file with *both sides' intent* (this lane's task and commits
 * on the file; the base's commits on it). When the agent goes quiet Styx verifies: no unmerged paths, no markers,
 * the project's checks pass; then it commits the merge, tells the chat and Home, and keeps the pre-merge state so
 * the whole thing can be undone in one step. Red → one more turn with the reason; red again → the merge is undone
 * and the lane is exactly as it was. Auto and review differ only in what the chat says: both commit, because a
 * half-merged tree is the one state an agent must never inherit.
 */
export class MergeResolveService {
  /** One verify per lane at a time: the turn settling and a `land` call can both ask for it. */
  private readonly verifying = new Map<string, Promise<void>>();

  constructor(private readonly deps: MergeResolveDeps) {}

  /**
   * At startup: a lane left at `checking` by a Styx that quit (or crashed) mid-verify goes back to `resolving`, so
   * the next turn, a `land` or Stop merging can move it. Nothing is checking at startup, so nothing is lost.
   */
  recover(): void {
    for (const wt of this.deps.repos.worktrees.all()) {
      if (wt.resolution?.state !== 'checking') continue;
      this.save({ ...wt, resolution: { ...wt.resolution, state: 'resolving' } });
    }
  }

  /**
   * `caller` is the session asking through the `land` tool: when it owns the lane, its being mid-turn is no reason
   * to refuse (it is waiting on this very call), and the resolve turn reaches it as its next message.
   */
  async resolve(
    worktreeId: string,
    opts: { caller?: string | null } = {},
  ): Promise<{ started: boolean; merged: number }> {
    const { repos, git, clock } = this.deps;
    const wt = repos.worktrees.get(worktreeId) ?? fail('not-found', `worktree ${worktreeId} not found`);
    if (wt.isMain) fail('invalid-input', 'the main worktree is the base; nothing to bring in');
    if (wt.archivedAt !== null) fail('invalid-input', 'the lane is archived');
    const branch = wt.branch ?? fail('invalid-input', copy.publish.noBranch);
    if (wt.resolution !== null && (wt.resolution.state === 'resolving' || wt.resolution.state === 'checking'))
      return { started: false, merged: 0 };
    const project = repos.projects.get(wt.projectId) ?? fail('not-found', 'project not found');
    const base = this.deps.baseOf(project.id);
    const owner = wt.owner.kind === 'session' ? repos.sessions.get(wt.owner.sessionId) : null;
    const live = owner !== null && owner.state !== 'done' && owner.archivedAt === null ? owner : null;
    const byOwner = live !== null && opts.caller === live.id;
    if (live !== null && !byOwner && (live.state === 'working' || live.state === 'needs-you'))
      fail('invalid-input', fill(copy.sync.busy, { agent: copy.agentProducts[live.agent], base }));
    if (await git.mergeInProgress(wt.path))
      fail('invalid-input', 'a merge is already in progress in this lane');

    if ((await git.remotes(project.path)).length > 0) await git.fetch(project.path).catch(() => undefined);
    const behind = (await git.aheadBehind(project.path, branch, base)).behind;
    if (behind === 0) {
      if (wt.behindBase !== 0 || wt.conflict !== null) this.save({ ...wt, behindBase: 0, conflict: null });
      return { started: false, merged: 0 };
    }

    // Uncommitted work is committed first (git will not merge over it); the undo point is that commit.
    if (this.deps.commitLane !== undefined && !(await git.status(wt.path)).clean)
      await this.deps.commitLane(wt.id, fill(copy.sync.wipCommit, { branch, base }));
    // Before anything moves: HEAD and a checkpoint of the tree, so the whole merge can be undone in one step.
    const preHead = (await git.headCommit(wt.path)) ?? fail('git-error', 'the lane has no commits yet');
    const preTree = (await git.status(wt.path)).clean ? null : await this.deps.checkpoints.capture(wt.path);
    await git.setConfig(wt.path, 'rerere.enabled', 'true').catch(() => undefined);
    const merge = await git.merge(wt.path, base);
    const started = clock.now();
    const stub: WorktreeResolution = {
      state: 'resolving',
      sessionId: null,
      files: [],
      preHead,
      preTree,
      mergeCommit: null,
      attempts: 1,
      startedAt: started,
      finishedAt: null,
      failure: null,
    };
    if (merge.ok) {
      // rerere replayed an earlier resolution, or the dry run was stale: a clean merge is just a sync.
      await this.landed(
        wt,
        base,
        { ...stub, files: [] },
        (await git.headCommit(wt.path)) ?? preHead,
        'mechanical',
      );
      return { started: false, merged: behind };
    }
    let files = await git.conflictedFiles(wt.path);
    if (files.length === 0) {
      await git.mergeAbort(wt.path);
      fail('git-error', merge.output || `git merge ${base} failed`);
    }
    files = await this.mechanical(wt, files);
    if (files.length === 0) {
      await git.addAll(wt.path);
      await git.commit(wt.path, this.mergeMessage(base, branch, []), { asUser: true });
      await this.landed(wt, base, stub, (await git.headCommit(wt.path)) ?? preHead, 'mechanical');
      return { started: false, merged: behind };
    }

    const turn = await this.turnText(wt, base, branch, files, live ?? owner);
    let sessionId: SessionId;
    if (live !== null) {
      sessionId = live.id;
      this.save({ ...wt, resolution: { ...stub, sessionId, files } });
      if (live.state === 'paused' && live.pausedReason === 'conflict')
        this.deps.sessions.applyEvent(live.id, { type: 'resolve' });
      this.deps.transcript.system(
        live.id,
        fill(copy.resolve.started, { base, files: listOf(files), agent: copy.agentProducts[live.agent] }),
      );
      await this.deps.sessions.sendMessage(live.id, turn, [], { now: true, from: 'styx' });
    } else {
      // The lane's agent is gone: a hidden merge task on the same lane, with the project's default agent.
      sessionId = await this.spawnTask(wt, turn);
      const fresh = repos.worktrees.get(wt.id) ?? wt; // the spawn re-owned the lane
      this.save({ ...fresh, resolution: { ...stub, sessionId, files } });
    }
    const agent = repos.sessions.get(sessionId)?.agent ?? this.deps.settingsOf(project.id).defaultAgent;
    this.deps.activity.append({
      who: copy.agentProducts[agent],
      what: `${project.name} · ${fill(copy.resolve.activity.started, { agent: copy.agentProducts[agent], base, branch })}`,
      projectId: project.id,
      sessionId,
    });
    logger.info('merge resolve: handed to the agent', { branch, base, files, sessionId });
    return { started: true, merged: 0 };
  }

  /** The agent went quiet: if this session was finishing a merge for a lane, verify it and commit or hand back. */
  async onTurnSettled(sessionId: string): Promise<void> {
    const wt = this.deps.repos.worktrees
      .all()
      .find((w) => w.resolution?.sessionId === sessionId && w.resolution.state === 'resolving');
    if (!wt || wt.resolution === null) return;
    await this.verifyOnce(wt.id);
  }

  /**
   * Verify now rather than when a turn ends: the lane's agent called `land` (saying it is done, from inside its
   * turn), or the agent went quiet without the settle being seen. A no-op unless a merge is being finished.
   */
  async verifyNow(worktreeId: string): Promise<void> {
    const res = this.deps.repos.worktrees.get(worktreeId)?.resolution;
    if (res === null || res === undefined) return;
    if (res.state !== 'resolving' && res.state !== 'checking') return;
    await this.verifyOnce(worktreeId);
  }

  private verifyOnce(worktreeId: string): Promise<void> {
    const inflight = this.verifying.get(worktreeId);
    if (inflight !== undefined) return inflight;
    const run = this.verifySafely(worktreeId).finally(() => this.verifying.delete(worktreeId));
    this.verifying.set(worktreeId, run);
    return run;
  }

  /**
   * `verify`, made safe to leave: a locked index is waited out, and anything else that throws puts the lane back
   * to `resolving` with the reason. Before this a throw left the lane at `checking` for good — Land refused,
   * Stop merging did nothing, and only hand-editing the database moved it.
   */
  private async verifySafely(worktreeId: string): Promise<void> {
    const { repos, transcript } = this.deps;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt += 1) {
      const wt = repos.worktrees.get(worktreeId);
      const res = wt?.resolution ?? null;
      if (!wt || res === null || (res.state !== 'resolving' && res.state !== 'checking')) return;
      try {
        await this.verify(wt, res);
        return;
      } catch (e) {
        const message = (e as Error).message;
        const delay = LOCK_RETRY_MS[attempt];
        if (LOCKED.test(message) && delay !== undefined) {
          logger.info('merge resolve: git is busy, verifying again shortly', { worktreeId, delay });
          await sleep(delay);
          continue;
        }
        const now = repos.worktrees.get(worktreeId) ?? wt;
        const reason = firstLine(message);
        this.save({
          ...now,
          resolution: { ...(now.resolution ?? res), state: 'resolving', failure: reason },
        });
        const session = res.sessionId === null ? null : repos.sessions.get(res.sessionId);
        if (session !== null && session.state !== 'done')
          transcript.system(
            session.id,
            fill(copy.resolve.verifyError, { reason, agent: copy.agentProducts[session.agent] }),
          );
        logger.warn('merge resolve: verify failed', { worktreeId, error: message });
        return;
      }
    }
  }

  /** Puts the lane back to before its last resolved merge, while nothing has been committed on top. */
  async undo(worktreeId: string): Promise<void> {
    const { repos, git } = this.deps;
    const wt = repos.worktrees.get(worktreeId) ?? fail('not-found', `worktree ${worktreeId} not found`);
    const res = wt.resolution;
    // `checking` with no verify running is a verify that died: stopping it must still be possible.
    if (
      res !== null &&
      (res.state === 'resolving' || (res.state === 'checking' && !this.verifying.has(wt.id)))
    )
      return this.stop(wt, res);
    if (res === null || res.state !== 'done' || res.mergeCommit === null)
      fail('invalid-transition', 'nothing to undo on this lane');
    if ((await git.headCommit(wt.path)) !== res.mergeCommit)
      fail('invalid-transition', 'the lane has moved on since that merge; nothing was undone');
    const owner = wt.owner.kind === 'session' ? repos.sessions.get(wt.owner.sessionId) : null;
    if (owner !== null && owner.state === 'working')
      fail(
        'invalid-input',
        fill(copy.sync.busy, {
          agent: copy.agentProducts[owner.agent],
          base: this.deps.baseOf(wt.projectId),
        }),
      );
    await this.rollback(wt, res);
    const project = repos.projects.get(wt.projectId);
    const base = this.deps.baseOf(wt.projectId);
    const behind =
      project && wt.branch !== null
        ? ((await git.aheadBehind(project.path, wt.branch, base).catch(() => null))?.behind ?? 0)
        : 0;
    const conflict =
      project && wt.branch !== null
        ? await git.detectConflict(project.path, wt.branch, base).catch(() => null)
        : null;
    this.save({ ...wt, headCommit: res.preHead, behindBase: behind, conflict, resolution: null });
    if (owner !== null && owner.state !== 'done')
      this.deps.transcript.system(owner.id, fill(copy.resolve.undone, { base }));
    this.deps.activity.append({
      who: copy.repo.you,
      what: `${project?.name ?? ''} · ${fill(copy.resolve.activity.undone, { base, branch: wt.branch ?? '' })}`,
      projectId: wt.projectId,
      sessionId: owner?.id ?? null,
    });
    await this.deps.ledger.laneChanged(wt.id);
  }

  /**
   * Stop merging (the person's way out while the agent is still at it): the agent's turn is interrupted, the
   * merge is undone and the lane is back to before it, with the conflict marked so Resolve is offered again.
   * Without this a merge the agent could not finish stayed "merging…" with nothing to click.
   */
  private async stop(wt: Worktree, res: WorktreeResolution): Promise<void> {
    const { repos, clock } = this.deps;
    const base = this.deps.baseOf(wt.projectId);
    const session = res.sessionId === null ? null : repos.sessions.get(res.sessionId);
    if (session !== null && session.state !== 'done') this.deps.sessions.interrupt(session.id);
    await this.rollback(wt, res);
    const failed: WorktreeResolution = {
      ...res,
      state: 'failed',
      finishedAt: clock.now(),
      failure: copy.resolve.reasons.stopped,
    };
    const conflict = { file: res.files[0] ?? '', against: base };
    this.save({ ...wt, headCommit: res.preHead, conflict, resolution: failed });
    const owner = wt.owner.kind === 'session' ? repos.sessions.get(wt.owner.sessionId) : null;
    if (owner !== null && owner.state !== 'done') {
      this.deps.transcript.system(owner.id, fill(copy.resolve.stopped, { base }));
      if (owner.state !== 'paused')
        this.deps.sessions.applyEvent(owner.id, { type: 'error', reason: 'conflict' });
    }
    const project = repos.projects.get(wt.projectId);
    this.deps.activity.append({
      who: copy.repo.you,
      what: `${project?.name ?? ''} · ${fill(copy.resolve.activity.stopped, { base, branch: wt.branch ?? '' })}`,
      projectId: wt.projectId,
      sessionId: owner?.id ?? null,
    });
    await this.deps.ledger.laneChanged(wt.id);
  }

  // --- internals ------------------------------------------------------------------

  /** Mergiraf on each conflicted file when it is installed; what it fully solves is staged, the rest is returned. */
  private async mechanical(wt: Worktree, files: string[]): Promise<string[]> {
    const solve = this.deps.mergiraf;
    if (solve === undefined) return files;
    const left: string[] = [];
    for (const file of files) {
      const solved = await solve(file, wt.path).catch(() => false);
      if (solved && (await this.filesWithMarkers(wt.path, [file])).length === 0)
        await this.deps.git.add(wt.path, [file]);
      else left.push(file);
    }
    return left;
  }

  private async turnText(
    wt: Worktree,
    base: string,
    branch: string,
    files: readonly string[],
    owner: Session | null,
  ): Promise<string> {
    const { git } = this.deps;
    const task = owner === null ? '' : taskOf(owner);
    const lines: string[] = [];
    for (const file of files) {
      const ours = await git.subjects(wt.path, `${base}..${branch}`, file);
      const theirs = await git.subjects(wt.path, `${branch}..${base}`, file);
      lines.push(
        fill(copy.agentPrompt.resolveFile, {
          file,
          branch,
          base,
          task: task === '' ? copy.lanes.noTask : task,
          ours: ours.length === 0 ? copy.agentPrompt.resolveUncommitted : ours.join('; '),
          theirs: theirs.length === 0 ? copy.agentPrompt.resolveUncommitted : theirs.join('; '),
        }),
      );
    }
    const checks = this.deps.settingsOf(wt.projectId).checksCommand;
    return fill(copy.agentPrompt.resolve, {
      base,
      branch,
      files: lines.join('\n'),
      checks:
        checks === null
          ? copy.agentPrompt.resolveChecksUnknown
          : fill(copy.agentPrompt.resolveChecksKnown, { command: checks }),
    });
  }

  private async spawnTask(wt: Worktree, firstMessage: string): Promise<SessionId> {
    const s = this.deps.settingsOf(wt.projectId);
    const { sessionId } = await this.deps.sessions.start({
      projectId: wt.projectId,
      agent: s.defaultAgent,
      worktree: { kind: 'existing', worktreeId: wt.id },
      firstMessage,
      toggles: { autoApproveEdits: true, mayRequestTargets: false, notifyWhenNeedsMe: s.notifyWhenNeedsMe },
      model: s.model,
      permissionMode: s.taskPermissionMode,
      effort: s.effort,
      purpose: 'merge',
    });
    return sessionId;
  }

  private async verify(wt: Worktree, res: WorktreeResolution): Promise<void> {
    const { git } = this.deps;
    this.save({ ...wt, resolution: { ...res, state: 'checking' } });
    const inProgress = await git.mergeInProgress(wt.path);
    const head = await git.headCommit(wt.path);
    // The working tree is what counts: an agent that rewrote a file without `git add` leaves it "unmerged" in the
    // index, which `add -A` clears; markers left in the file, or an aborted merge, are the real failures.
    let reason: string | null = null;
    if (!inProgress && head === res.preHead) reason = copy.resolve.reasons.gone; // the agent aborted it
    if (reason === null) {
      const marked = await this.filesWithMarkers(wt.path, res.files);
      if (marked.length > 0) reason = fill(copy.resolve.reasons.markers, { files: listOf(marked) });
    }
    const checks = this.deps.settingsOf(wt.projectId).checksCommand;
    let checked = false;
    if (reason === null && checks !== null) {
      const r = await this.deps.runChecks(wt.path, checks);
      checked = true;
      if (r.exitCode !== 0)
        reason =
          fill(copy.resolve.reasons.checks, { command: checks, code: r.exitCode }) +
          (r.output === '' ? '' : `\n${r.output}`);
    }
    if (reason !== null) {
      await this.handBack(wt, res, reason);
      return;
    }
    const base = this.deps.baseOf(wt.projectId);
    let mergeCommit = head ?? res.preHead;
    if (inProgress) {
      await git.addAll(wt.path);
      await git.commit(wt.path, this.mergeMessage(base, wt.branch ?? '', res.files), { asUser: true });
      mergeCommit = (await git.headCommit(wt.path)) ?? mergeCommit;
    }
    await this.landed(wt, base, res, mergeCommit, checked ? 'checked' : 'unchecked');
  }

  /** The merge is not good yet: one more turn with the reason, or — out of attempts — undo it all. */
  private async handBack(wt: Worktree, res: WorktreeResolution, reason: string): Promise<void> {
    const { repos, clock } = this.deps;
    const base = this.deps.baseOf(wt.projectId);
    const branch = wt.branch ?? '';
    const session = res.sessionId === null ? null : repos.sessions.get(res.sessionId);
    const agent = session === null ? this.deps.settingsOf(wt.projectId).defaultAgent : session.agent;
    if (res.attempts < MAX_ATTEMPTS && session !== null) {
      const retry = fill(copy.agentPrompt.resolveRetry, { reason });
      if (session.state !== 'done') {
        this.save({
          ...wt,
          resolution: { ...res, state: 'resolving', attempts: res.attempts + 1, failure: reason },
        });
        this.deps.transcript.system(
          session.id,
          fill(copy.resolve.retry, { reason: firstLine(reason), agent: copy.agentProducts[session.agent] }),
        );
        await this.deps.sessions.sendMessage(session.id, retry, [], { now: true, from: 'styx' });
        return;
      }
      if (session.purpose === 'merge') {
        // A hidden task ends when it goes quiet; the second attempt is a fresh one with the same brief.
        const turn = await this.turnText(wt, base, branch, res.files, null);
        const next = await this.spawnTask(wt, `${turn}\n\n${retry}`);
        const fresh = repos.worktrees.get(wt.id) ?? wt;
        this.save({
          ...fresh,
          resolution: {
            ...res,
            state: 'resolving',
            sessionId: next,
            attempts: res.attempts + 1,
            failure: reason,
          },
        });
        return;
      }
    }
    await this.rollback(wt, res);
    const failed: WorktreeResolution = { ...res, state: 'failed', finishedAt: clock.now(), failure: reason };
    const conflict = { file: res.files[0] ?? '', against: base };
    this.save({ ...wt, headCommit: res.preHead, conflict, resolution: failed });
    const owner = wt.owner.kind === 'session' ? repos.sessions.get(wt.owner.sessionId) : null;
    const live = owner !== null && owner.state !== 'done' ? owner : null;
    if (live !== null) {
      this.deps.transcript.system(live.id, fill(copy.resolve.failed, { base, reason: firstLine(reason) }));
      if (live.state !== 'paused')
        this.deps.sessions.applyEvent(live.id, { type: 'error', reason: 'conflict' });
    }
    const project = repos.projects.get(wt.projectId);
    this.deps.activity.append({
      who: copy.agentProducts[agent],
      what: `${project?.name ?? ''} · ${fill(copy.resolve.activity.failed, { base, branch })}`,
      projectId: wt.projectId,
      sessionId: session?.id ?? null,
    });
    logger.info('merge resolve: given up', { branch, base, reason: firstLine(reason) });
  }

  /** The merge is committed: rows, the chat, Home; the lane ledger re-reads the lane. */
  private async landed(
    wt: Worktree,
    base: string,
    res: WorktreeResolution,
    mergeCommit: string,
    how: 'mechanical' | 'checked' | 'unchecked',
  ): Promise<void> {
    const { repos, git, clock } = this.deps;
    const project = repos.projects.get(wt.projectId);
    const branch = wt.branch ?? '';
    const behind =
      project === null
        ? 0
        : ((await git.aheadBehind(project.path, branch, base).catch(() => null))?.behind ?? 0);
    const fresh = repos.worktrees.get(wt.id) ?? wt;
    this.save({
      ...fresh,
      headCommit: mergeCommit,
      conflict: null,
      behindBase: behind,
      resolution: { ...res, state: 'done', mergeCommit, finishedAt: clock.now(), failure: null },
    });
    const owner = fresh.owner.kind === 'session' ? repos.sessions.get(fresh.owner.sessionId) : null;
    const live = owner !== null && owner.state !== 'done' ? owner : null;
    if (live !== null) {
      if (live.state === 'paused' && live.pausedReason === 'conflict')
        this.deps.sessions.applyEvent(live.id, { type: 'resolve' });
      const files = listOf(res.files);
      const line =
        how === 'mechanical'
          ? res.files.length === 0
            ? fill(copy.sync.synced, { base, n: 1 })
            : fill(copy.resolve.mechanical, { base, files })
          : this.deps.settingsOf(wt.projectId).integration === 'review'
            ? fill(copy.resolve.doneReview, { base, files })
            : how === 'checked'
              ? fill(copy.resolve.done, { base, files })
              : fill(copy.resolve.doneNoChecks, { base, files });
      this.deps.transcript.system(live.id, line);
    }
    this.deps.activity.append({
      who: live === null ? copy.repo.you : copy.agentProducts[live.agent],
      what: `${project?.name ?? ''} · ${fill(copy.resolve.activity.done, { base, branch, files: listOf(res.files) || copy.general.none })}`,
      projectId: wt.projectId,
      sessionId: live?.id ?? res.sessionId,
    });
    await this.deps.ledger.laneChanged(wt.id);
    logger.info('merge resolve: landed', { branch, base, how, files: res.files });
  }

  /** Everything back to before the merge: the merge aborted if still open, HEAD reset, the tree checkpoint restored. */
  private async rollback(wt: Worktree, res: WorktreeResolution): Promise<void> {
    const { git } = this.deps;
    if (await git.mergeInProgress(wt.path)) await git.mergeAbort(wt.path);
    await git.resetHard(wt.path, res.preHead);
    if (res.preTree !== null) await this.deps.checkpoints.restoreTree(wt.path, res.preTree);
  }

  private async filesWithMarkers(worktreePath: string, files: readonly string[]): Promise<string[]> {
    const marked: string[] = [];
    for (const file of files) {
      const text = await readFile(join(worktreePath, file), 'utf8').catch(() => null);
      if (text !== null && /^(<{7}|={7}|>{7})(\s|$)/m.test(text)) marked.push(file);
    }
    return marked;
  }

  private mergeMessage(base: string, branch: string, files: readonly string[]): string {
    const head = `Bring in ${base} into ${branch}`;
    return files.length === 0
      ? head
      : `${head}\n\nResolved with the agent, both sides kept: ${files.join(', ')}`;
  }

  /** Writes over the row as it is *now* (the hunk watcher and the ledger write the same row): `wt` is only the id and the patch. */
  private save(wt: Worktree): void {
    const current = this.deps.repos.worktrees.get(wt.id);
    const next = current === null ? wt : { ...current, ...pick(wt) };
    this.deps.repos.worktrees.upsert(next);
    this.deps.publisher.upsert('worktrees', [wt.id]);
  }
}

/** The fields the resolver owns on a lane row; everything else stays as the row is now. */
const pick = (wt: Worktree): Pick<Worktree, 'headCommit' | 'conflict' | 'behindBase' | 'resolution'> => ({
  headCommit: wt.headCommit,
  conflict: wt.conflict,
  behindBase: wt.behindBase,
  resolution: wt.resolution,
});

/** `a.ts, b.ts, c.ts (+2 more)` */
const listOf = (files: readonly string[]): string =>
  files.slice(0, LIST_MAX).join(', ') +
  (files.length > LIST_MAX ? ` (${fill(copy.lanes.more, { n: files.length - LIST_MAX })})` : '');

const firstLine = (s: string): string => s.split('\n')[0] ?? s;

/** Production checks runner: the command in the user's login shell, in the lane, output tail kept. */
export const checksInLoginShell =
  (loginPath: () => Promise<string>, shell: () => string, platform: NodeJS.Platform) =>
  async (cwd: string, command: string): Promise<ChecksResult> => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env))
      if (v !== undefined && !STRIPPED_ENV.has(k) && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    env['PATH'] = await loginPath();
    const r =
      platform === 'win32'
        ? await execa(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
            {
              cwd,
              env,
              reject: false,
              timeout: CHECKS_TIMEOUT_MS,
              windowsHide: true,
            },
          )
        : await execa(shell(), ['-ilc', command], { cwd, env, reject: false, timeout: CHECKS_TIMEOUT_MS });
    const output = `${String(r.stdout ?? '')}\n${String(r.stderr ?? '')}`.trim();
    return {
      exitCode: r.exitCode ?? 1,
      output: output.length > OUTPUT_TAIL ? output.slice(-OUTPUT_TAIL) : output,
    };
  };

/** Mergiraf's `solve` on a file when the tool is on the login PATH; absent → nothing is solved mechanically. */
export const mergirafSolver =
  (loginPath: () => Promise<string>, platform: NodeJS.Platform) =>
  async (file: string, cwd: string): Promise<boolean> => {
    const bin = findOnPath('mergiraf', await loginPath(), platform);
    if (bin === null) return false;
    const r = await execa(bin, ['solve', '--keep-backup=false', file], {
      cwd,
      reject: false,
      timeout: 60_000,
    });
    return r.exitCode === 0;
  };

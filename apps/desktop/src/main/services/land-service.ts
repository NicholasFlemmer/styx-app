import { copy, fill, type Worktree, type WorktreeLanding } from '@styx/core';
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import { fail } from '../ipc/bus';
import type { Publisher } from '../store/publisher';
import type { ActivityService } from './activity-service';
import type { GitService } from './git';
import { isSecretFile, logger } from './logger';
import type { ChecksResult } from './merge-resolve-service';
import { fallbackDraft, statsOf, type PublishMessage, type PublishResult } from './publish-service';
import type { TranscriptService } from './transcript-service';

export interface LandSettings {
  integration: 'auto' | 'review';
  autoLand: boolean;
  checksCommand: string | null;
}

export interface LandDeps {
  repos: Repos;
  git: GitService;
  publisher: Publisher;
  clock: Clock;
  transcript: TranscriptService;
  activity: ActivityService;
  baseOf: (projectId: string) => string;
  settingsOf: (projectId: string) => LandSettings;
  /** Keep lanes current (ADR-0023): the base comes into the lane first; a conflict goes to the resolver. */
  laneSync: { sync(worktreeId: string): Promise<{ merged: number; conflict: { file: string } | null }> };
  resolver: { resolve(worktreeId: string): Promise<{ started: boolean }> };
  /**
   * Publish's own steps (ADR-0021): the lane's commit (secret files stay out, the user's identity) and the base's
   * push (the same grant, audit and activity path as the Publish button).
   */
  publish: {
    publish(
      worktreeId: string,
      opts: { through: 'commit' | 'push'; message: PublishMessage; draft: boolean },
    ): Promise<PublishResult>;
  };
  runChecks: (cwd: string, command: string) => Promise<ChecksResult>;
}

export interface LandFile {
  path: string;
  added: number;
  removed: number;
}

export interface LandPreview {
  base: string;
  files: LandFile[];
  willPush: boolean;
  remote: string | null;
}

export interface LandResult {
  commit: string;
  pushed: boolean;
  steps: string[];
}

/**
 * Landing (ADR-0025 phase C): a lane's work goes into the base branch in one step. What is uncommitted is
 * committed first (agents seldom commit on their own); the base is brought into the lane (a conflict goes to the
 * resolver and the landing waits for it); the project's checks run in the lane; the lane is merged into the base
 * with `--no-ff` and the summary as the record; the base is pushed when it has a remote; and the lane stays,
 * marked landed, with Undo (a revert of the landing commit) while that commit is still the base's HEAD.
 *
 * Landings of one project run one after another: the next one brings the freshly moved base into its lane before
 * anything else — the sequential, gated merging the research recommends. With `autoLand` on (auto mode only), a
 * lane lands by itself when its session finishes cleanly; that path never spends a prompt on the summary.
 */
export class LandService {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: LandDeps) {}

  /** The files the lane would land (committed and not), and where the base goes afterwards. */
  async preview(worktreeId: string): Promise<LandPreview> {
    const { repos } = this.deps;
    const wt = repos.worktrees.get(worktreeId) ?? fail('not-found', `worktree ${worktreeId} not found`);
    const branch = wt.branch ?? fail('invalid-input', copy.publish.noBranch);
    const project = repos.projects.get(wt.projectId) ?? fail('not-found', 'project not found');
    const base = this.deps.baseOf(project.id);
    const files = await this.filesOf(project.path, wt.path, base, branch);
    const remote = await this.remoteOf(project.path);
    return { base, files, willPush: remote !== null, remote };
  }

  /** Lands the lane; landings of one project run one after another. */
  land(worktreeId: string, message: PublishMessage, opts: { auto?: boolean } = {}): Promise<LandResult> {
    const wt =
      this.deps.repos.worktrees.get(worktreeId) ?? fail('not-found', `worktree ${worktreeId} not found`);
    const prev = this.queues.get(wt.projectId) ?? Promise.resolve();
    const go = () => this.doLand(worktreeId, message, opts.auto === true);
    const run = prev.then(go, go);
    this.queues.set(
      wt.projectId,
      run.catch(() => undefined),
    );
    return run;
  }

  private async doLand(worktreeId: string, message: PublishMessage, auto: boolean): Promise<LandResult> {
    const { repos, git, clock } = this.deps;
    const wt = repos.worktrees.get(worktreeId) ?? fail('not-found', `worktree ${worktreeId} not found`);
    if (wt.isMain) fail('invalid-input', 'the main worktree is the base; nothing to land');
    if (wt.archivedAt !== null) fail('invalid-input', 'the lane is archived');
    const branch = wt.branch ?? fail('invalid-input', copy.publish.noBranch);
    if (wt.landing !== null && wt.landing.undoneAt === null)
      fail('invalid-transition', fill(copy.land.alreadyLanded, { branch }));
    const project = repos.projects.get(wt.projectId) ?? fail('not-found', 'project not found');
    const base = this.deps.baseOf(project.id);
    const owner = wt.owner.kind === 'session' ? repos.sessions.get(wt.owner.sessionId) : null;
    const agent = copy.agentProducts[owner?.agent ?? 'claude'];
    if (owner !== null && (owner.state === 'working' || owner.state === 'needs-you'))
      fail('invalid-input', fill(copy.land.busy, { agent, branch }));
    if (wt.resolution !== null && (wt.resolution.state === 'resolving' || wt.resolution.state === 'checking'))
      fail('invalid-transition', fill(copy.land.resolving, { base, agent }));
    // The base is merged in its own checkout: it has to be on the base, and clean.
    const current = await git.currentBranch(project.path);
    if (current !== base)
      fail('invalid-input', fill(copy.land.baseNotCheckedOut, { current: current ?? '?', base }));
    if (!(await git.status(project.path)).clean) fail('invalid-input', fill(copy.land.dirtyBase, { base }));

    const steps: string[] = [];
    // 1. Commit what the agent left uncommitted, as Publish would (by name; secret files stay out).
    if (!(await git.status(wt.path)).clean) {
      const r = await this.deps.publish.publish(wt.id, { through: 'commit', message, draft: false });
      if (r.commit !== null) steps.push(fill(copy.land.steps.commit, { commit: r.commit.slice(0, 7) }));
    }
    // 2. The base comes into the lane; a conflict is the resolver's and the landing waits for it.
    const synced = await this.deps.laneSync.sync(wt.id);
    if (synced.conflict !== null) {
      await this.deps.resolver.resolve(wt.id).catch(() => undefined);
      fail('invalid-transition', fill(copy.land.resolving, { base, agent }));
    }
    if (synced.merged > 0) steps.push(fill(copy.land.steps.sync, { base, n: synced.merged }));
    if ((await git.aheadBehind(project.path, branch, base)).ahead === 0)
      fail('invalid-input', fill(copy.land.nothing, { branch, base }));
    // 3. The checks, in the lane, before anything reaches the base.
    const checks = this.deps.settingsOf(project.id).checksCommand;
    if (checks !== null) {
      const r = await this.deps.runChecks(wt.path, checks);
      if (r.exitCode !== 0)
        fail(
          'invalid-transition',
          fill(copy.land.checksFailed, { command: checks, code: r.exitCode, branch }) +
            (r.output === '' ? '' : `\n${r.output}`),
        );
      steps.push(copy.land.steps.checks);
    }
    // 4. The merge into the base: one commit naming the lane, the summary as its message.
    const text = message.body.trim() === '' ? message.title : `${message.title}\n\n${message.body}`;
    const merged = await git.mergeNoFf(project.path, branch, text);
    if (!merged.ok) {
      const file = (await git.conflictedFiles(project.path).catch(() => []))[0] ?? copy.general.none;
      await git.mergeAbort(project.path).catch(() => undefined);
      fail('git-error', fill(copy.land.conflict, { branch, file, base }));
    }
    const commit = (await git.headCommit(project.path)) ?? fail('git-error', 'no commit after the merge');
    steps.push(fill(copy.land.steps.merge, { base, commit: commit.slice(0, 7) }));
    // 5. Push the base when it has somewhere to go.
    const mainRow = repos.worktrees.byProject(project.id).find((w) => w.isMain) ?? null;
    const remote = await this.remoteOf(project.path);
    let pushed = false;
    if (remote !== null && mainRow !== null) {
      pushed = (await this.deps.publish.publish(mainRow.id, { through: 'push', message, draft: false }))
        .pushed;
      if (pushed) steps.push(fill(copy.land.steps.push, { base }));
    }
    // 6. Rows, the chat, Home. The lane stays, landed, with Undo.
    const now = clock.now();
    const landing: WorktreeLanding = { commit, base, pushed, at: now, undoneAt: null };
    this.patch(wt.id, (w) => ({ ...w, mergedAt: now, landing, behindBase: 0, conflict: null }));
    if (mainRow !== null) this.patch(mainRow.id, (w) => ({ ...w, headCommit: commit }));
    const pushedSuffix = pushed ? fill(copy.land.pushedSuffix, { remote: remote ?? '' }) : '';
    if (owner !== null)
      this.deps.transcript.system(
        owner.id,
        fill(auto ? copy.land.chatAuto : copy.land.chat, { branch, base, pushed: pushedSuffix }),
      );
    this.deps.activity.append({
      who: auto && owner !== null ? copy.agentProducts[owner.agent] : copy.repo.you,
      what: `${project.name} · ${fill(auto ? copy.land.activity.landedAuto : copy.land.activity.landed, { branch, base })}`,
      projectId: project.id,
      sessionId: owner?.id ?? null,
    });
    logger.info('land: landed', { branch, base, commit, pushed, auto });
    return { commit, pushed, steps };
  }

  /** Takes a landing back out of the base while it is the base's HEAD: a revert commit, pushed again if the landing was. */
  async undo(worktreeId: string): Promise<void> {
    const { repos, git, clock } = this.deps;
    const wt = repos.worktrees.get(worktreeId) ?? fail('not-found', `worktree ${worktreeId} not found`);
    const landing = wt.landing;
    if (landing === null || landing.undoneAt !== null) fail('invalid-transition', copy.land.undoNothing);
    const project = repos.projects.get(wt.projectId) ?? fail('not-found', 'project not found');
    const base = landing.base;
    const branch = wt.branch ?? '';
    const current = await git.currentBranch(project.path);
    if (current !== base)
      fail('invalid-input', fill(copy.land.baseNotCheckedOut, { current: current ?? '?', base }));
    if ((await git.headCommit(project.path)) !== landing.commit)
      fail('invalid-transition', fill(copy.land.undoMoved, { base }));
    if (!(await git.status(project.path)).clean) fail('invalid-input', fill(copy.land.dirtyBase, { base }));
    const r = await git.revertMerge(project.path, landing.commit);
    if (!r.ok) fail('git-error', r.output || 'git revert failed');
    const reverted = (await git.headCommit(project.path)) ?? landing.commit;
    const mainRow = repos.worktrees.byProject(project.id).find((w) => w.isMain) ?? null;
    const remote = await this.remoteOf(project.path);
    let pushed = false;
    if (landing.pushed && remote !== null && mainRow !== null) {
      const message = { title: `Revert "${branch}"`, body: '' };
      pushed = (await this.deps.publish.publish(mainRow.id, { through: 'push', message, draft: false }))
        .pushed;
    }
    const now = clock.now();
    this.patch(wt.id, (w) => ({ ...w, mergedAt: null, landing: { ...landing, undoneAt: now } }));
    if (mainRow !== null) this.patch(mainRow.id, (w) => ({ ...w, headCommit: reverted }));
    const owner = wt.owner.kind === 'session' ? repos.sessions.get(wt.owner.sessionId) : null;
    const pushedSuffix = pushed ? fill(copy.land.pushedSuffix, { remote: remote ?? '' }) : '';
    if (owner !== null)
      this.deps.transcript.system(owner.id, fill(copy.land.undone, { branch, base, pushed: pushedSuffix }));
    this.deps.activity.append({
      who: copy.repo.you,
      what: `${project.name} · ${fill(copy.land.activity.undone, { branch, base })}`,
      projectId: project.id,
      sessionId: owner?.id ?? null,
    });
    logger.info('land: undone', { branch, base, reverted, pushed });
  }

  /**
   * `autoLand` (auto mode): the session ended by itself — land its lane if it has anything for the base. A refusal
   * is a line in the chat, never a crash: the human can still land from Repo.
   */
  async maybeAutoLand(sessionId: string): Promise<void> {
    const { repos, git } = this.deps;
    const session = repos.sessions.get(sessionId);
    if (!session || session.purpose || session.exitCode !== 0) return;
    const settings = this.deps.settingsOf(session.projectId);
    if (settings.integration !== 'auto' || !settings.autoLand) return;
    const wt = repos.worktrees.get(session.worktreeId);
    if (!wt || wt.isMain || wt.archivedAt !== null || wt.branch === null || wt.mergedAt !== null) return;
    const project = repos.projects.get(wt.projectId);
    if (!project) return;
    const base = this.deps.baseOf(project.id);
    const files = await this.filesOf(project.path, wt.path, base, wt.branch).catch(() => []);
    const ahead = (await git.aheadBehind(project.path, wt.branch, base).catch(() => null))?.ahead ?? 0;
    if (files.length === 0 && ahead === 0) return;
    const message = fallbackDraft(files, 'commit', wt.branch);
    try {
      await this.land(wt.id, message, { auto: true });
    } catch (e) {
      const reason = ((e as Error).message.split('\n')[0] ?? '').trim();
      this.deps.transcript.system(session.id, fill(copy.land.failed, { error: reason }));
      logger.info('land: automatic landing did not happen', { branch: wt.branch, reason });
    }
  }

  /** Committed against the base plus what is still uncommitted, one line per file (secret files never counted). */
  private async filesOf(
    projectPath: string,
    lanePath: string,
    base: string,
    branch: string,
  ): Promise<LandFile[]> {
    const byPath = new Map<string, LandFile>();
    for (const f of await this.deps.git.numstatFiles(projectPath, base, branch)) byPath.set(f.path, { ...f });
    const patch = await this.deps.git.diffWithUntracked(lanePath, 'HEAD').catch(() => '');
    for (const f of statsOf(patch)) {
      const seen = byPath.get(f.path);
      if (seen === undefined) byPath.set(f.path, { ...f });
      else
        byPath.set(f.path, { path: f.path, added: seen.added + f.added, removed: seen.removed + f.removed });
    }
    return [...byPath.values()]
      .filter((f) => !isSecretFile(f.path))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  private async remoteOf(projectPath: string): Promise<string | null> {
    const remotes = await this.deps.git.remotes(projectPath).catch(() => []);
    return (remotes.find((r) => r.name === 'origin') ?? remotes[0])?.name ?? null;
  }

  private patch(worktreeId: string, fn: (w: Worktree) => Worktree): void {
    const current = this.deps.repos.worktrees.get(worktreeId);
    if (current === null) return;
    this.deps.repos.worktrees.upsert(fn(current));
    this.deps.publisher.upsert('worktrees', [worktreeId]);
  }
}

import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  AGENT_LABEL,
  copy,
  fill,
  headAsk,
  newId,
  openAskCount,
  sessionTransition,
  type Agent,
  type AskId,
  type PendingAsk,
  type Project,
  type Session,
  type SessionEffect,
  type SessionEvent,
  type SessionId,
  type SessionToggles,
  type Worktree,
  type WorktreeId,
} from '@styx/core';
import { buildAgentLaunch, type AgentLaunch, type AgentLaunchContext } from '../agents';
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import { fail } from '../ipc/bus';
import { projectSettingsFor } from '../store/projection';
import type { Publisher } from '../store/publisher';
import type { DetectService } from './detect-service';
import type { GitService} from './git';
import { worktreeLocation } from './git';
import { logger } from './logger';
import type { NotificationService } from './notification-service';
import type { PtyService } from './pty-service';
import type { ActivityService } from './activity-service';
import type { TranscriptService } from './transcript-service';

export const QUIET_MS = 3000;

export interface SessionServiceDeps {
  repos: Repos;
  publisher: Publisher;
  clock: Clock;
  pty: PtyService;
  git: GitService;
  detect: DetectService;
  transcript: TranscriptService;
  activity: ActivityService;
  notifications: NotificationService | null;
  /** Broker endpoint + paths injected into every agent pty (plan §6). */
  runtime: {
    brokerEndpoint: string;
    shimDir: string;
    cliPath: string;
    exePath: string;
    userData: string;
    platform: NodeJS.Platform;
  };
}

/** Late-bound collaborators (GrantService and the broker host depend on SessionService in turn). */
export interface SessionHooks {
  revokeSessionGrants: (sessionId: SessionId) => void;
  /** Reject a broker request that was held on an ask which is now cancelled. */
  cancelHeldAsk: (ask: PendingAsk) => void;
  /** Hunk watcher lifecycle for agent worktrees. */
  watchWorktree: (session: Session, worktree: Worktree) => void;
  unwatchWorktree: (worktreeId: WorktreeId) => void;
}

export interface SpawnInput {
  projectId: string;
  agent: Agent;
  worktree: { kind: 'new'; base: string; branch: string } | { kind: 'existing'; worktreeId: string };
  firstMessage: string;
  toggles: SessionToggles;
  model: string | null;
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * Owns session rows, their ptys, and the session state machine (core `machines/session`): every transition is
 * write DB → effects → `store.delta`. Runner is `pty` for every agent until the Phase 7 stream spike (ADR-0010).
 */
export class SessionService {
  private hooks: SessionHooks | null = null;
  private readonly quietTimers = new Map<string, NodeJS.Timeout>();
  private readonly launches = new Map<string, AgentLaunch>();

  constructor(private readonly deps: SessionServiceDeps) {
    deps.pty.on('data', (id, data) => this.onPtyData(id, data));
    deps.pty.on('exit', (id, exitCode) => this.onPtyExit(id, exitCode));
  }

  bind(hooks: SessionHooks): void {
    this.hooks = hooks;
  }

  get(id: string): Session | null {
    return this.deps.repos.sessions.get(id);
  }

  require(id: string): Session {
    return this.deps.repos.sessions.get(id) ?? fail('not-found', `session ${id} not found`);
  }

  // --- spawn ---------------------------------------------------------------

  async spawn(input: SpawnInput): Promise<{ session: Session; worktree: Worktree; token: string }> {
    const { repos, clock } = this.deps;
    const project =
      repos.projects.get(input.projectId) ?? fail('not-found', `project ${input.projectId} not found`);
    const repo =
      repos.repos.byProject(project.id) ?? fail('not-found', `project ${project.name} has no repo`);
    const settings = projectSettingsFor(repos, project.id);
    const now = clock.now();
    const sessionId = newId<'SessionId'>();

    let worktree: Worktree;
    if (input.worktree.kind === 'existing') {
      worktree =
        repos.worktrees.get(input.worktree.worktreeId) ??
        fail('not-found', `worktree ${input.worktree.worktreeId} not found`);
    } else {
      const branch = input.worktree.branch;
      const path =
        settings.worktreeLocation.value === 'inside'
          ? join(project.path, '.styx', 'worktrees', branch.replace(/[^A-Za-z0-9._-]+/g, '-'))
          : worktreeLocation(project.path, branch);
      await this.deps.git.worktreeAdd(project.path, { branch, base: input.worktree.base, path });
      const head = await this.deps.git.headCommit(path);
      worktree = {
        id: newId<'WorktreeId'>(),
        repoId: repo.id,
        projectId: project.id,
        branch,
        path,
        isMain: false,
        owner: { kind: 'session', sessionId },
        baseCommit: head,
        headCommit: head,
        changes: { added: 0, removed: 0, files: 0 },
        pr: null,
        conflict: null,
        mergedAt: null,
        createdAt: now,
        archivedAt: null,
      };
    }

    const token = randomBytes(32).toString('hex');
    const session: Session = {
      id: sessionId,
      projectId: project.id,
      worktreeId: worktree.id,
      agent: input.agent,
      runner: 'pty',
      model: input.model,
      state: 'idle',
      pausedReason: null,
      note: null,
      firstMessage: input.firstMessage || null,
      toggles: input.toggles,
      pid: null,
      exitCode: null,
      startedAt: now,
      lastActivityAt: null,
      endedAt: null,
      archivedAt: null,
    };
    repos.transaction(() => {
      repos.sessions.upsert(session);
      repos.sessions.setBrokerTokenHash(session.id, sha256(token));
      if (input.worktree.kind === 'new' || worktree.owner.kind === 'user') {
        worktree = {
          ...worktree,
          owner: worktree.isMain ? worktree.owner : { kind: 'session', sessionId },
          baseCommit: worktree.baseCommit ?? worktree.headCommit,
        };
        repos.worktrees.upsert(worktree);
      }
      repos.projects.upsert({ ...project, lastActivityAt: now });
    });
    this.deps.publisher.upsert('sessions', [session.id]);
    this.deps.publisher.upsert('worktrees', [worktree.id]);
    this.deps.publisher.upsert('projects', [project.id]);
    if (input.firstMessage) this.deps.transcript.user(session.id, input.firstMessage);
    this.deps.activity.append({ who: AGENT_LABEL[session.agent], what: `${project.name} · spawned on ${worktree.branch}`, projectId: project.id, sessionId: session.id });

    await this.launch(session, worktree, project, token);
    this.hooks?.watchWorktree(this.require(session.id), worktree);
    return { session: this.require(session.id), worktree, token };
  }

  private async launch(session: Session, worktree: Worktree, project: Project, token: string): Promise<void> {
    const { repos, runtime } = this.deps;
    const cli = repos.discovery.cli(session.agent);
    const binary = session.agent === 'shell' ? this.deps.pty.defaultShell() : (cli?.binary ?? null);
    if (session.agent !== 'shell' && (binary === null || cli?.found === false)) {
      this.applyEvent(session.id, { type: 'error', reason: 'cli-missing' });
      return;
    }
    const env: Record<string, string> = {
      STYX_SESSION_ID: session.id,
      STYX_BROKER: runtime.brokerEndpoint,
      STYX_TOKEN: token,
      STYX_PROJECT_ID: project.id,
      STYX_WORKTREE: worktree.path,
      STYX_SHIM_DIR: runtime.shimDir,
      STYX_CLI: runtime.cliPath,
      STYX_EXE: runtime.exePath,
      MCP_TIMEOUT: '60000',
      PATH: `${runtime.shimDir}${runtime.platform === 'win32' ? ';' : ':'}${await this.deps.pty.resolveLoginPath()}`,
    };
    const ctx: AgentLaunchContext = {
      agent: session.agent,
      binary: binary ?? '',
      sessionId: session.id,
      worktreePath: worktree.path,
      firstMessage: session.firstMessage,
      model: session.model,
      configDir: join(runtime.userData, 'agents', session.id),
      shimDir: runtime.shimDir,
      platform: runtime.platform,
      env,
    };
    const launch = await buildAgentLaunch(ctx);
    this.launches.set(session.id, launch);
    try {
      const { pid } = await this.deps.pty.spawn({
        id: session.id,
        cwd: worktree.path,
        shell: launch.command,
        args: launch.args,
        env: { ...env, ...launch.env },
      });
      const s = this.require(session.id);
      repos.sessions.upsert({ ...s, pid });
      this.deps.publisher.upsert('sessions', [s.id]);
      this.applyEvent(session.id, { type: 'start' });
      if (launch.typeFirstMessage && session.firstMessage) {
        setTimeout(() => this.deps.pty.write(session.id, `${session.firstMessage ?? ''}\r`), 400).unref?.();
      }
    } catch (e) {
      logger.error('session spawn failed', { sessionId: session.id, error: (e as Error).message });
      this.applyEvent(session.id, { type: 'error', reason: 'cli-missing' });
    }
  }

  // --- input / control -----------------------------------------------------

  sendMessage(sessionId: string, body: string): void {
    const s = this.require(sessionId);
    if (s.state === 'done') fail('invalid-transition', 'session has finished');
    this.deps.transcript.user(s.id, body);
    if (this.deps.pty.has(s.id)) this.deps.pty.write(s.id, `${body}\r`);
    this.applyEvent(s.id, { type: 'activity' });
  }

  ptyInput(sessionId: string, data: string): void {
    this.deps.pty.write(sessionId, data);
  }

  ptyResize(sessionId: string, cols: number, rows: number): void {
    this.deps.pty.resize(sessionId, cols, rows);
  }

  stop(sessionId: string): void {
    const s = this.require(sessionId);
    if (this.deps.pty.has(s.id)) {
      this.deps.pty.kill(s.id);
      // `finish` follows from the pty exit event
      return;
    }
    if (s.state !== 'done') this.applyEvent(s.id, { type: 'finish', exitCode: null });
  }

  archive(sessionId: string): void {
    const s = this.require(sessionId);
    if (s.state !== 'done') fail('invalid-transition', 'only finished sessions can be archived');
    this.deps.repos.sessions.upsert({ ...s, archivedAt: this.deps.clock.now() });
    this.deps.publisher.upsert('sessions', [s.id]);
  }

  async resume(sessionId: string): Promise<void> {
    const s = this.require(sessionId);
    if (s.state !== 'paused') fail('invalid-transition', 'session is not paused');
    if (s.pausedReason === 'cli-missing' && !this.deps.pty.has(s.id)) {
      const clis = await this.deps.detect.detectClis();
      const now = this.deps.clock.now();
      for (const c of clis)
        this.deps.repos.discovery.saveCli({
          agent: c.agent,
          binary: c.binary,
          version: c.version,
          found: c.found,
          authState: c.authState,
          capabilities: c.capabilities,
          checkedAt: now,
        });
      this.deps.publisher.discoverySet(this.deps.repos.discovery.ides(), this.deps.repos.discovery.clis());
      const cli = this.deps.repos.discovery.cli(s.agent);
      if (!cli?.found) fail('cli-missing', fill(copy.errors.spawnCliMissing, { cli: s.agent }));
      this.applyEvent(s.id, { type: 'resolve' });
      const worktree = this.deps.repos.worktrees.get(s.worktreeId) ?? fail('not-found', 'worktree missing');
      const project = this.deps.repos.projects.get(s.projectId) ?? fail('not-found', 'project missing');
      const token = randomBytes(32).toString('hex');
      this.deps.repos.sessions.setBrokerTokenHash(s.id, sha256(token));
      await this.launch(this.require(s.id), worktree, project, token);
      return;
    }
    this.applyEvent(s.id, { type: 'resolve' });
  }

  /** Kill every live pty (shutdown). */
  killAll(): void {
    for (const t of this.quietTimers.values()) clearTimeout(t);
    this.quietTimers.clear();
    this.deps.pty.killAll();
  }

  // --- pty events ----------------------------------------------------------

  private onPtyData(id: string, data: string): void {
    this.deps.publisher.pty(id, data);
    const s = this.deps.repos.sessions.get(id);
    if (!s) return; // user terminals share the pty service
    this.applyEvent(id, { type: 'activity' });
    const prev = this.quietTimers.get(id);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.quietTimers.delete(id);
      this.applyEvent(id, { type: 'quiet' });
    }, QUIET_MS);
    t.unref?.();
    this.quietTimers.set(id, t);
  }

  private onPtyExit(id: string, exitCode: number): void {
    this.deps.publisher.ptyExit(id, exitCode);
    const s = this.deps.repos.sessions.get(id);
    if (!s) return;
    const launch = this.launches.get(id);
    if (launch) {
      void launch.cleanup().catch(() => undefined);
      this.launches.delete(id);
    }
    this.applyEvent(id, { type: 'finish', exitCode });
  }

  // --- state machine -------------------------------------------------------

  /** Applies a core session event; invalid transitions are ignored (logged at debug). Returns the new session or null. */
  applyEvent(sessionId: string, event: SessionEvent): Session | null {
    const { repos, clock } = this.deps;
    const s = repos.sessions.get(sessionId);
    if (!s) return null;
    const open = openAskCount(repos.pendingAsks.openBySession(s.id));
    const t = sessionTransition(s.state, event, {
      now: clock.now(),
      sessionId: s.id,
      openAskCount: open,
      pausedReason: s.pausedReason,
      notifyWhenNeedsMe: s.toggles.notifyWhenNeedsMe,
    });
    if (t === null) {
      logger.debug('session: invalid transition', { sessionId, state: s.state, event: event.type });
      return s;
    }
    const now = clock.now();
    const next: Session = {
      ...s,
      state: t.state,
      pausedReason: t.pausedReason,
      lastActivityAt: event.type === 'activity' || event.type === 'start' ? now : s.lastActivityAt,
      endedAt: t.state === 'done' ? (s.endedAt ?? now) : null,
      exitCode: event.type === 'finish' ? event.exitCode : s.exitCode,
      pid: t.state === 'done' ? null : s.pid,
    };
    if (t.state === 'done' && next.endedAt === null) next.endedAt = now;
    const changed = JSON.stringify(next) !== JSON.stringify(s);
    if (changed) {
      repos.sessions.upsert(next);
      this.deps.publisher.upsert('sessions', [next.id]);
    }
    for (const effect of t.effects) this.runEffect(effect, next);
    if (t.state === 'done' && s.state !== 'done') {
      const project = repos.projects.get(next.projectId);
      this.deps.activity.append({ who: AGENT_LABEL[next.agent], what: `${project?.name ?? ''} · finished${next.exitCode !== null && next.exitCode !== 0 ? ` (exit ${next.exitCode})` : ''}`, projectId: next.projectId, sessionId: next.id });
    }
    return next;
  }

  setNote(sessionId: string, note: string | null): void {
    const s = this.require(sessionId);
    this.deps.repos.sessions.upsert({ ...s, note });
    this.deps.publisher.upsert('sessions', [s.id]);
  }

  private runEffect(effect: SessionEffect, session: Session): void {
    const { repos, publisher, clock } = this.deps;
    switch (effect.type) {
      case 'notify':
        this.notifyAsk(session, effect.askId);
        return;
      case 'promoteAsk': {
        const head = headAsk(repos.pendingAsks.openBySession(session.id));
        if (head) this.notifyAsk(session, head.id);
        return;
      }
      case 'cancelOpenAsks': {
        const now = clock.now();
        const ids: string[] = [];
        for (const a of repos.pendingAsks.openBySession(session.id)) {
          repos.pendingAsks.upsert({ ...a, state: 'cancelled', resolvedAt: now });
          ids.push(a.id);
          this.hooks?.cancelHeldAsk(a);
          for (const n of repos.notifications.byAsk(a.id)) {
            repos.notifications.upsert({ ...n, state: 'resolved', resolvedAt: now });
            publisher.upsert('notifications', [n.id]);
          }
        }
        publisher.upsert('pendingAsks', ids);
        this.deps.notifications?.onAskResolved('', repos.pendingAsks.openAll().length);
        return;
      }
      case 'cancelTimers': {
        const t = this.quietTimers.get(session.id);
        if (t) clearTimeout(t);
        this.quietTimers.delete(session.id);
        this.hooks?.unwatchWorktree(session.worktreeId);
        return;
      }
      case 'revokeSessionGrants':
        this.hooks?.revokeSessionGrants(session.id);
        return;
      case 'setBanner':
        this.setBanner(session, effect.reason);
        return;
      case 'clearBanner':
        this.clearBanner(session);
        return;
      case 'postSystemMessage':
        this.deps.transcript.system(session.id, effect.body);
        return;
    }
  }

  private notifyAsk(session: Session, askId: AskId): void {
    const { repos, publisher } = this.deps;
    const ask = repos.pendingAsks.get(askId);
    if (!ask || ask.state !== 'open') return;
    const project = repos.projects.get(session.projectId);
    const worktree = repos.worktrees.get(session.worktreeId);
    const agentLabel = AGENT_LABEL[session.agent];
    let title = `${agentLabel} needs you`;
    let meta = `${project?.name ?? ''} · ${worktree?.branch ?? ''}`;
    if (ask.payload.kind === 'grant') {
      const grant = repos.grants.get(ask.payload.grantId);
      const target = grant ? repos.targets.get(grant.targetId) : null;
      if (grant && target) {
        title = fill(copy.toast.title, {
          agent: agentLabel,
          target: `${target.name} ${target.env}`,
          scope: grant.scope.join(' + '),
        });
        meta = fill(copy.toast.meta, {
          project: project?.name ?? '',
          branch: worktree?.branch ?? '',
          reason: grant.reason,
        });
      }
    } else if (ask.payload.kind === 'plan') {
      title = `${agentLabel} · ${ask.payload.summary}`;
    } else {
      title = `${agentLabel} · ${ask.payload.prompt}`;
    }
    const existing = repos.notifications
      .byAsk(ask.id)
      .find((n) => n.state === 'shown' || n.state === 'later');
    if (!existing) {
      const id = `notif-${ask.id}`;
      repos.notifications.upsert({
        id,
        kind: 'needs-you',
        sessionId: session.id,
        askId: ask.id,
        projectId: session.projectId,
        title,
        body: meta,
        meta: null,
        osDelivered: this.deps.notifications !== null && !this.deps.notifications.dnd,
        state: 'shown',
        bannerKey: null,
        createdAt: this.deps.clock.now(),
        resolvedAt: null,
      });
      publisher.upsert('notifications', [id]);
    }
    publisher.sendEvent('ask.opened', { askId: ask.id, sessionId: session.id, projectId: session.projectId });
    this.deps.notifications?.onAskOpened(
      {
        askId: ask.id,
        sessionId: session.id,
        projectName: project?.name ?? '',
        branch: worktree?.branch ?? null,
        agentLabel,
        title,
        meta,
      },
      repos.pendingAsks.openAll().length,
    );
  }

  private setBanner(session: Session, reason: 'cli-missing' | 'conflict' | 'auth-expired'): void {
    const { repos, publisher } = this.deps;
    const worktree = repos.worktrees.get(session.worktreeId);
    const agentLabel = AGENT_LABEL[session.agent];
    let text: string;
    let cta: string;
    let action:
      | { kind: 'install-guide'; agent: Agent }
      | { kind: 'resolve'; worktreeId: WorktreeId }
      | { kind: 'reconnect'; targetId: never };
    let bannerKey: string;
    if (reason === 'cli-missing') {
      const n =
        repos.sessions
          .all()
          .filter(
            (s) => s.agent === session.agent && s.state === 'paused' && s.pausedReason === 'cli-missing',
          ).length || 1;
      text =
        n === 1
          ? fill(copy.errors.cliMissing.textOne, { cli: session.agent })
          : fill(copy.errors.cliMissing.text, { cli: session.agent, n });
      cta = copy.errors.cliMissing.cta;
      action = { kind: 'install-guide', agent: session.agent };
      bannerKey = `cli-missing:${session.agent}`;
    } else if (reason === 'conflict') {
      text = fill(copy.errors.conflict.text, {
        branch: worktree?.branch ?? '',
        file: worktree?.conflict?.file ?? '',
        agent: agentLabel,
      });
      cta = copy.errors.conflict.cta;
      action = { kind: 'resolve', worktreeId: session.worktreeId };
      bannerKey = `conflict:${session.worktreeId}`;
    } else {
      // auth-expired banners are raised by TargetService with the target id; here we only mark the session.
      return;
    }
    const existing = repos.notifications.byBannerKey(bannerKey);
    const id = existing?.id ?? `banner-${bannerKey}`;
    repos.notifications.upsert({
      id,
      kind: 'error-banner',
      sessionId: session.id,
      askId: null,
      projectId: session.projectId,
      title: text,
      body: '',
      meta: null,
      osDelivered: false,
      state: 'shown',
      bannerKey,
      createdAt: existing?.createdAt ?? this.deps.clock.now(),
      resolvedAt: null,
    });
    publisher.upsert('notifications', [id]);
    publisher.sendEvent('banner.set', {
      bannerKey,
      kind: reason,
      text,
      cta,
      action,
      sessionId: session.id,
      reason,
    });
  }

  private clearBanner(session: Session): void {
    const { repos, publisher } = this.deps;
    const keys = [`cli-missing:${session.agent}`, `conflict:${session.worktreeId}`];
    for (const key of keys) {
      const n = repos.notifications.byBannerKey(key);
      if (!n || n.state === 'resolved') continue;
      const stillPaused = repos.sessions
        .all()
        .some(
          (s) =>
            s.id !== session.id &&
            s.state === 'paused' &&
            (key.startsWith('cli-missing') ? s.agent === session.agent : s.worktreeId === session.worktreeId),
        );
      if (stillPaused) continue;
      repos.notifications.upsert({ ...n, state: 'resolved', resolvedAt: this.deps.clock.now() });
      publisher.upsert('notifications', [n.id]);
      publisher.sendEvent('banner.clear', { bannerKey: key });
    }
  }

  /** Marks the head ask resolved and moves the session on (used by ask.respond and GrantService). */
  resolveAsk(askId: string, resolution: PendingAsk['resolution']): PendingAsk {
    const { repos, publisher, clock } = this.deps;
    const ask = repos.pendingAsks.get(askId) ?? fail('not-found', `ask ${askId} not found`);
    if (ask.state !== 'open') fail('invalid-transition', 'ask is not open');
    const now = clock.now();
    const next: PendingAsk = { ...ask, state: 'resolved', resolution, resolvedAt: now };
    repos.pendingAsks.upsert(next);
    publisher.upsert('pendingAsks', [ask.id]);
    for (const n of repos.notifications.byAsk(ask.id)) {
      if (n.state === 'resolved') continue;
      repos.notifications.upsert({ ...n, state: 'acted', resolvedAt: now });
      publisher.upsert('notifications', [n.id]);
    }
    this.deps.notifications?.onAskResolved(ask.id, repos.pendingAsks.openAll().length);
    this.applyEvent(ask.sessionId, { type: 'ask-resolved', askId: ask.id });
    return next;
  }

  /** Opens a non-grant ask (plan / decision / question) from the broker. */
  openAsk(
    sessionId: string,
    payload: Exclude<PendingAsk['payload'], { kind: 'grant' }>,
    brokerRequestId: string | null,
  ): PendingAsk {
    const { repos, publisher, clock } = this.deps;
    const s = this.require(sessionId);
    const ask: PendingAsk = {
      id: newId<'AskId'>(),
      sessionId: s.id,
      kind: payload.kind,
      grantId: null,
      payload,
      state: 'open',
      resolution: null,
      position: repos.pendingAsks.nextPosition(s.id),
      brokerRequestId,
      createdAt: clock.now(),
      resolvedAt: null,
    };
    repos.pendingAsks.upsert(ask);
    publisher.upsert('pendingAsks', [ask.id]);
    if (payload.kind === 'plan')
      this.deps.transcript.append(s.id, payload.summary, { kind: 'agent' }, ask.id);
    else if (payload.kind === 'decision')
      this.deps.transcript.append(
        s.id,
        payload.prompt,
        { kind: 'decision', options: payload.options, chosen: null },
        ask.id,
      );
    else this.deps.transcript.append(s.id, payload.prompt, { kind: 'agent' }, ask.id);
    this.setNote(s.id, payload.kind === 'plan' ? payload.summary : payload.prompt);
    this.applyEvent(s.id, { type: 'ask', askId: ask.id });
    return ask;
  }
}

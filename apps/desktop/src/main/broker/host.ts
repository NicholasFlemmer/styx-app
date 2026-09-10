import { timingSafeEqual } from 'node:crypto';
import {
  BrokerError,
  BrokerServer,
  ErrorCode,
  type ConnectionContext,
  type Params,
  type Result,
  type SessionBrief,
} from '@styx/broker';
import {
  isLive,
  openUntil,
  type AskResolution,
  type Grant,
  type PendingAsk,
  type Scope,
  type Target,
} from '@styx/core';
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import type { IssuedCredential, ProviderRegistry } from '../providers';
import type { GrantOutcome, GrantService } from '../services/grant-service';
import type { HunkService } from '../services/hunk-service';
import { logger, redact, redactArgv } from '../services/logger';
import { sha256, type SessionService } from '../services/session-service';

export interface BrokerHostDeps {
  repos: Repos;
  grants: GrantService;
  sessions: SessionService;
  hunks: Pick<HunkService, 'rescan'>;
  providers: ProviderRegistry;
  clock: Clock;
  endpoint: string;
}

const activeResult = (
  grant: Grant,
  decidedBy: NonNullable<Grant['decidedBy']>,
): Result<'request_access'> => ({
  status: 'active',
  grantId: grant.id,
  scope: [...grant.scope],
  expiresAt: openUntil(grant),
  decidedBy,
});

const toBrokerResolution = (ask: PendingAsk, r: AskResolution): Result<'ask_user'>['resolution'] => {
  if (r.kind === 'plan')
    return {
      kind: 'plan',
      answer: r.outcome === 'approved' ? 'approve' : 'reject',
      ...(r.note !== null ? { note: r.note } : {}),
    };
  if (r.kind === 'decision') return { kind: 'decision', answer: r.chosen };
  if (r.kind === 'question') return { kind: 'question', answer: r.answer };
  // A question set answers the broker's `ask_user` with one line per question (free text wins over labels).
  if (r.kind === 'questions')
    return {
      kind: 'question',
      answer: r.answers
        .map((a) => a.freeText?.trim() || a.chosen.join(', '))
        .filter((t) => t !== '')
        .join('\n'),
    };
  return {
    kind: ask.kind === 'plan' ? 'plan' : 'question',
    answer: r.outcome === 'granted' ? 'approve' : 'reject',
  } as Result<'ask_user'>['resolution'];
};

/**
 * Main-process side of the broker (plan §6): authenticates sessions by token hash, resolves targets within the
 * session's project, and holds `request_access` / `exec_authorize` / `ask_user` replies until the user decides.
 */
export class BrokerHost {
  readonly server: BrokerServer;
  private readonly waits = new Map<string, NodeJS.Timeout>();
  /** Session that opened each held `exec:` request; `always` grants detach from their session on issue. */
  private readonly holdSessions = new Map<string, string>();

  constructor(private readonly deps: BrokerHostDeps) {
    this.server = new BrokerServer({
      authenticate: (sessionId, token) => this.authenticate(sessionId, token),
      now: () => deps.clock.now(),
      rateLimitPerMinute: 5,
      onLog: (level, msg, meta) => (level === 'warn' ? logger.warn(msg, meta) : logger.info(msg, meta)),
    });
    this.register();
    deps.grants.onDecision((grant, outcome) => this.onGrantDecision(grant, outcome));
  }

  listen(): Promise<void> {
    return this.server.listen(this.deps.endpoint);
  }

  async close(): Promise<void> {
    for (const t of this.waits.values()) clearTimeout(t);
    this.waits.clear();
    this.holdSessions.clear();
    await this.server.close();
  }

  // --- auth ----------------------------------------------------------------

  private async authenticate(sessionId: string, token: string): Promise<SessionBrief | null> {
    const stored = this.deps.repos.sessions.brokerTokenHash(sessionId);
    if (!stored) return null;
    const a = Buffer.from(stored, 'hex');
    const b = Buffer.from(sha256(token), 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const s = this.deps.repos.sessions.get(sessionId);
    if (!s || s.state === 'done') return null;
    const project = this.deps.repos.projects.get(s.projectId);
    const worktree = this.deps.repos.worktrees.get(s.worktreeId);
    return {
      sessionId: s.id,
      projectId: s.projectId,
      projectName: project?.name ?? '',
      worktreePath: worktree?.path ?? null,
      branch: worktree?.branch ?? null,
      agent: s.agent,
    };
  }

  // --- handlers --------------------------------------------------------------

  private resolveTarget(ctx: ConnectionContext, name: string): Target {
    const t = this.deps.repos.targets.resolve(ctx.session.projectId, name);
    if (!t)
      throw new BrokerError(ErrorCode.targetNotFound, `no target "${name}" in ${ctx.session.projectName}`);
    return this.usable(t);
  }

  /** A target an agent may open a request on: connected and not expired (both `request_access` and `exec_authorize`, L-c). */
  private usable(t: Target): Target {
    if (t.credentialRef === null)
      throw new BrokerError(ErrorCode.notAllowed, `${t.name} is not connected; connect it in Styx`);
    if (t.health === 'expired')
      throw new BrokerError(ErrorCode.notAllowed, `${t.name} credentials expired; reconnect it in Styx`);
    return t;
  }

  /**
   * A grant this connection may see: bound to its session, or persistent (`sessionId === null`) on a target in its
   * project. Persistent grants are otherwise reachable from any project by id (M3).
   */
  private visibleGrant(ctx: ConnectionContext, grantId: string): Grant {
    const grant = this.deps.repos.grants.get(grantId);
    if (!grant || (grant.sessionId !== null && grant.sessionId !== ctx.session.sessionId))
      throw new BrokerError(ErrorCode.targetNotFound, 'unknown grant');
    const target = this.deps.repos.targets.get(grant.targetId);
    if (!target || target.projectId !== ctx.session.projectId)
      throw new BrokerError(ErrorCode.targetNotFound, 'unknown grant');
    return grant;
  }

  private holdKey(
    kind: 'grant' | 'exec' | 'ask',
    id: string,
    req: { id: string | number },
    ctx: ConnectionContext,
  ): string {
    return `${kind}:${id}:${ctx.connectionId}:${req.id}`;
  }

  private heldFor(prefix: string): string[] {
    return this.server.heldKeys().filter((k) => k.startsWith(prefix));
  }

  private armWait(key: string, waitMs: number, onTimeout: () => void): void {
    if (waitMs <= 0) return;
    const t = setTimeout(() => {
      this.waits.delete(key);
      onTimeout();
    }, waitMs);
    t.unref?.();
    this.waits.set(key, t);
  }

  private register(): void {
    const { deps, server } = this;

    server.on('request_access', async (p, ctx, req) => {
      const target = this.resolveTarget(ctx, p.target);
      const outcome = await deps.grants.request({
        sessionId: ctx.session.sessionId as Grant['sessionId'],
        targetId: target.id,
        scope: [...p.scope],
        reason: p.reason,
        triggeredBy: p.triggeredBy ?? 'mcp:request_access',
      });
      return this.outcomeToResult(outcome, req, ctx, p.waitMs);
    });

    server.on('check_grant', async (p, ctx, req) => {
      const grant = this.visibleGrant(ctx, p.grantId);
      if (grant.state === 'active') return activeResult(grant, grant.decidedBy ?? 'user');
      if (grant.state === 'requested') {
        const key = this.holdKey('grant', grant.id, req, ctx);
        req.hold(key);
        this.armWait(key, p.waitMs, () =>
          server.resolveHeld(key, {
            status: 'pending',
            grantId: grant.id,
            queuePosition: this.queuePosition(grant),
          }),
        );
        return { status: 'pending', grantId: grant.id, queuePosition: 0 };
      }
      return { status: 'denied', grantId: grant.id };
    });

    server.on('get_credential', async (p, ctx) => {
      const grant = this.visibleGrant(ctx, p.grantId);
      if (!isLive(grant, deps.clock.now()))
        throw new BrokerError(ErrorCode.revoked, `grant is ${grant.state}`);
      const cred = await deps.grants.credentialFor(grant.id, {
        sessionId: ctx.session.sessionId,
        projectId: ctx.session.projectId,
      });
      deps.grants.use(grant.id, {
        command: null,
        scopeUsed: grant.scope[0] ?? 'read',
        via: 'get_credential',
        sessionId: ctx.session.sessionId,
      });
      return {
        kind: cred.kind,
        env: cred.env,
        ...(cred.kind === 'ssh-agent' ? { socketPath: cred.socketPath } : {}),
        expiresAt: cred.expiresAt,
        scoped: cred.scoped,
      };
    });

    server.on('exec_authorize', async (p, ctx, req) => {
      const adapter = deps.providers.forTool(p.tool);
      if (!adapter) throw new BrokerError(ErrorCode.notAllowed, `${p.tool} is not a Styx-managed tool`);
      const scopes = adapter.scopeOfCommand(p.argv, p.tool) as Scope[];
      // Persisted as grants.reason / grant_uses.command / audit triggered_by: never the raw argv (M1).
      const command = redact(`$ ${[p.tool, ...redactArgv(p.argv)].join(' ')}`);
      const picked = this.pickTarget(ctx, adapter.provider, p.argv, scopes);
      if (!picked)
        throw new BrokerError(
          ErrorCode.targetNotFound,
          `no ${adapter.provider} target in ${ctx.session.projectName}`,
        );
      const target = this.usable(picked);
      const covering = deps.grants.covering(target, ctx.session.sessionId, scopes);
      if (covering) {
        // Through credentialFor so a persistent grant issued before a restart is re-issued (project-bound, M3).
        const cred = await deps.grants.credentialFor(covering.id, { sessionId: ctx.session.sessionId, projectId: ctx.session.projectId });
        return this.authorizeUse(covering, command, scopes, ctx, cred);
      }
      // Only the path that inserts a grant request consumes the session's request bucket (L1); covered shim
      // execs stay unmetered.
      if (!server.allow(ctx.session.sessionId))
        throw new BrokerError(ErrorCode.rateLimited, 'too many access requests; try again in a minute');
      const outcome = await deps.grants.request({
        sessionId: ctx.session.sessionId as Grant['sessionId'],
        targetId: target.id,
        scope: scopes,
        reason: command,
        triggeredBy: command,
      });
      if (outcome.kind === 'active') return await this.authorizeUse(outcome.grant, command, scopes, ctx);
      if (outcome.kind === 'denied') throw new BrokerError(ErrorCode.notAllowed, 'access denied');
      const key = this.holdKey('exec', outcome.grant.id, req, ctx);
      req.hold(key);
      this.holdSessions.set(key, ctx.session.sessionId);
      this.armWait(key, 600_000, () => {
        this.holdSessions.delete(key);
        server.rejectHeld(key, { code: ErrorCode.notAllowed, message: 'timed out waiting for a decision' });
      });
      // resolved in onGrantDecision with { grantId, useId, env }
      return { grantId: outcome.grant.id, useId: '', env: {} };
    });

    server.on('exec_report', async (p, ctx) => {
      // A use row can only be closed by the session that opened it (L7).
      const use = deps.repos.grantUses.get(p.useId);
      if (!use || use.sessionId !== ctx.session.sessionId)
        throw new BrokerError(ErrorCode.targetNotFound, 'unknown use');
      deps.grants.endUse(p.useId, p.exitCode);
      return { ok: true };
    });

    server.on('ask_user', async (p, ctx, req) => {
      const payload = (p.payload ?? {}) as Record<string, unknown>;
      const str = (k: string) => (typeof payload[k] === 'string' ? (payload[k] as string) : '');
      const list = (k: string) =>
        Array.isArray(payload[k]) ? (payload[k] as unknown[]).map(String).filter(Boolean) : [];
      const askPayload: Exclude<PendingAsk['payload'], { kind: 'grant' }> =
        p.kind === 'plan'
          ? { kind: 'plan', summary: str('summary') || 'Plan ready', files: list('files') }
          : p.kind === 'decision'
            ? {
                kind: 'decision',
                prompt: str('prompt') || 'Decision',
                options: list('options').length ? list('options') : ['Yes', 'No'],
              }
            : { kind: 'question', prompt: str('prompt') || str('question') || 'Question' };
      const ask = deps.sessions.openAsk(ctx.session.sessionId, askPayload, String(req.id));
      const key = this.holdKey('ask', ask.id, req, ctx);
      req.hold(key);
      this.armWait(key, p.waitMs, () =>
        server.rejectHeld(key, { code: ErrorCode.internal, message: 'timed out waiting for the user' }),
      );
      return { resolution: { kind: 'question', answer: '' } };
    });

    server.on('report_status', async (p, ctx) => {
      deps.sessions.setNote(ctx.session.sessionId, p.note || null);
      if (p.state === 'working') deps.sessions.applyEvent(ctx.session.sessionId, { type: 'activity' });
      else if (p.state === 'idle') deps.sessions.applyEvent(ctx.session.sessionId, { type: 'quiet' });
      else if (p.state === 'done')
        deps.sessions.applyEvent(ctx.session.sessionId, { type: 'finish', exitCode: 0 });
      return { ok: true };
    });

    server.on('hook', async (p, ctx) => {
      this.onHook(ctx.session.sessionId, p.agent, p.event, p.payload);
      return { ok: true };
    });

    /** Peers in the caller's project. Discovery must exist before messaging: ids are ULIDs, never names. */
    server.on('list_sessions', async (_p, ctx) => {
      return deps.repos.sessions
        .byProject(ctx.session.projectId)
        .filter((x) => x.archivedAt === null)
        .map((x) => ({
          sessionId: x.id,
          agent: x.agent,
          branch: deps.repos.worktrees.get(x.worktreeId)?.branch ?? null,
          state: x.state,
          note: x.note ?? '',
          self: x.id === ctx.session.sessionId,
        }));
    });

    /**
     * Agent-to-agent messaging. This is a deliberate, narrow exception to an invariant enforced everywhere else
     * in this file: `to` is the first client-supplied session id the broker trusts after `hello`. Both guards
     * below are load-bearing — without the project check it becomes cross-project reach, and without the `done`
     * check it becomes a silent black hole that reports success into nothing.
     */
    server.on('send_message', async (p, ctx) => {
      if (p.to === ctx.session.sessionId)
        throw new BrokerError(ErrorCode.invalidParams, 'cannot message yourself');
      const target = deps.repos.sessions.get(p.to);
      if (!target || target.archivedAt !== null)
        throw new BrokerError(ErrorCode.targetNotFound, 'no such session');
      if (target.projectId !== ctx.session.projectId)
        throw new BrokerError(ErrorCode.notAllowed, 'session belongs to another project');
      if (target.state === 'done')
        throw new BrokerError(ErrorCode.notAllowed, 'that session has ended');
      const from = deps.repos.sessions.get(ctx.session.sessionId);
      if (!from) throw new BrokerError(ErrorCode.unauthenticated, 'unknown session');
      deps.sessions.deliverPeerMessage(from, target, p.body);
      return { delivered: true as const };
    });

    server.on('list_targets', async (_p, ctx) => {
      const now = deps.clock.now();
      return deps.repos.targets.byProject(ctx.session.projectId).map((t) => {
        const live = deps.repos.grants
          .byTarget(t.id)
          .filter((g) => isLive(g, now) && (g.sessionId === null || g.sessionId === ctx.session.sessionId));
        const persistent = live.find((g) => g.duration === 'always');
        const lockState =
          t.credentialRef === null
            ? 'unconnected'
            : t.health === 'expired'
              ? 'expired'
              : persistent || t.policy === 'always'
                ? 'persistent'
                : live.length > 0
                  ? 'open'
                  : 'locked';
        const scopes = [...new Set(live.flatMap((g) => g.scope))] as Scope[];
        return { name: t.name, provider: t.provider, env: t.env, lockState, scopes };
      });
    });
  }

  private outcomeToResult(
    outcome: GrantOutcome,
    req: { id: string | number; hold: (key: string) => void },
    ctx: ConnectionContext,
    waitMs: number,
  ): Result<'request_access'> {
    if (outcome.kind === 'active') return activeResult(outcome.grant, outcome.decidedBy);
    if (outcome.kind === 'denied') return { status: 'denied', grantId: outcome.grant.id };
    const key = this.holdKey('grant', outcome.grant.id, req, ctx);
    req.hold(key);
    this.deps.repos.pendingAsks.upsert({ ...outcome.ask, brokerRequestId: String(req.id) });
    this.armWait(key, waitMs, () =>
      this.server.resolveHeld(key, {
        status: 'pending',
        grantId: outcome.grant.id,
        queuePosition: this.queuePosition(outcome.grant),
      }),
    );
    return { status: 'pending', grantId: outcome.grant.id, queuePosition: 0 };
  }

  private queuePosition(grant: Grant): number {
    const ask = this.deps.repos.pendingAsks.byGrant(grant.id);
    return ask ? Math.max(0, this.deps.grants.queuePosition(ask.id)) : 0;
  }

  /**
   * Async because the credential must come through `credentialFor`: reading the raw cache would hand a shim a
   * bundle that has already expired, which is what made re-auth need an app restart.
   */
  private async authorizeUse(
    grant: Grant,
    command: string,
    scopes: Scope[],
    ctx: ConnectionContext,
    issued?: IssuedCredential,
  ): Promise<Result<'exec_authorize'>> {
    const target = this.deps.repos.targets.get(grant.targetId) ?? null;
    const cred =
      issued ??
      (await this.deps.grants
        .credentialFor(grant.id, {
          sessionId: ctx.session.sessionId,
          projectId: target?.projectId ?? ctx.session.projectId,
        })
        .catch(() => this.deps.grants.issuedCredential(grant.id)));
    const { useId } = this.deps.grants.use(grant.id, {
      command,
      scopeUsed: scopes[0] ?? 'read',
      via: 'shim',
      sessionId: ctx.session.sessionId,
    });
    return { grantId: grant.id, useId, env: cred?.env ?? {} };
  }

  /** Which target a shim call means: a live covering grant wins; `--prod`/`production` picks prod; else the first non-prod. */
  private pickTarget(
    ctx: ConnectionContext,
    provider: Target['provider'],
    argv: string[],
    scopes: Scope[],
  ): Target | null {
    const candidates = this.deps.repos.targets
      .byProject(ctx.session.projectId)
      .filter((t) => t.provider === provider);
    if (candidates.length === 0) return null;
    const covered = candidates.find(
      (t) => this.deps.grants.covering(t, ctx.session.sessionId, scopes) !== null,
    );
    if (covered) return covered;
    const wantsProd = argv.some((a) => a === '--prod' || a === '--production' || a === 'production');
    return (
      (wantsProd ? candidates.find((t) => t.env === 'prod') : candidates.find((t) => t.env !== 'prod')) ??
      candidates[0] ??
      null
    );
  }

  // --- decisions -------------------------------------------------------------

  private onGrantDecision(
    grant: Grant,
    outcome: 'granted' | 'denied' | 'cancelled' | 'revoked' | 'expired',
  ): void {
    if (outcome === 'revoked' || outcome === 'expired') {
      if (grant.sessionId)
        this.server.notify(grant.sessionId, 'grant.revoked', {
          grantId: grant.id,
          reason: grant.revokeReason ?? outcome,
        });
      return;
    }
    for (const key of this.heldFor(`grant:${grant.id}:`)) {
      this.clearWait(key);
      this.server.resolveHeld(
        key,
        outcome === 'granted'
          ? activeResult(grant, grant.decidedBy ?? 'user')
          : { status: 'denied', grantId: grant.id },
      );
    }
    for (const key of this.heldFor(`exec:${grant.id}:`)) {
      // `always` grants detach from the session on issue (grant.sessionId === null): attribute the use to the
      // session that held the request, never to ''.
      const heldSession = this.holdSessions.get(key) ?? grant.sessionId ?? '';
      this.clearWait(key);
      if (outcome !== 'granted') {
        this.server.rejectHeld(key, {
          code: ErrorCode.notAllowed,
          message: outcome === 'denied' ? 'access denied' : 'request cancelled',
        });
        continue;
      }
      const parts = key.split(':');
      const connId = Number(parts[2]);
      const ctx = {
        session: { sessionId: heldSession },
        connectionId: connId,
      } as ConnectionContext;
      const command = grant.reason;
      const scopes = [...grant.scope];
      void this.authorizeUse(grant, command, scopes, ctx).then(
        (result) => this.server.resolveHeld(key, result),
        (e: Error) => this.server.rejectHeld(key, { code: ErrorCode.internal, message: e.message }),
      );
    }
  }

  /** Called by `ask.respond` after SessionService resolved the row. */
  resolveAsk(ask: PendingAsk, resolution: AskResolution): void {
    for (const key of this.heldFor(`ask:${ask.id}:`)) {
      this.clearWait(key);
      this.server.resolveHeld(key, { resolution: toBrokerResolution(ask, resolution) });
    }
  }

  /** Session finished / ask cancelled: fail the held request so the agent does not hang. */
  cancelAsk(ask: PendingAsk): void {
    for (const key of [
      ...this.heldFor(`ask:${ask.id}:`),
      ...(ask.grantId
        ? [...this.heldFor(`grant:${ask.grantId}:`), ...this.heldFor(`exec:${ask.grantId}:`)]
        : []),
    ]) {
      this.clearWait(key);
      this.server.rejectHeld(key, { code: ErrorCode.revoked, message: 'request cancelled' });
    }
  }

  private clearWait(key: string): void {
    const t = this.waits.get(key);
    if (t) clearTimeout(t);
    this.waits.delete(key);
    this.holdSessions.delete(key);
  }

  notifyStopping(sessionId: string): void {
    this.server.notify(sessionId, 'session.stopping', {});
    this.server.disconnectSession(sessionId);
  }

  /** Hook → session-state mapping lives in SessionService.onHook (plan §5); the host only authenticates and forwards. */
  private onHook(sessionId: string, agent: Params<'hook'>['agent'], event: string, payload: unknown): void {
    this.deps.sessions.onHook(sessionId, agent, event, payload);
  }
}

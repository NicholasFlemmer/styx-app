import { randomBytes } from 'node:crypto';
import {
  AGENT_LABEL,
  copy,
  evaluate,
  fill,
  formatCountdown,
  idFrom,
  grantTransition,
  isLive,
  newId,
  openUntil,
  platformCopy,
  requiresMfa,
  shouldExpire,
  covers,
  type AskId,
  type Duration,
  type Grant,
  type GrantContext,
  type GrantEffect,
  type GrantEvent,
  type GrantId,
  type GrantUseVia,
  type PendingAsk,
  type Policy,
  type PolicyDecision,
  type Scope,
  type Session,
  type SessionId,
  type Target,
  type TargetId,
  type WorktreeId,
} from '@styx/core';
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import { targetLabel } from '../db/repos/targets';
import { fail } from '../ipc/bus';
import type { GrantInfo, IssuedCredential, ProviderRegistry, TargetInfo } from '../providers';
import type { Publisher } from '../store/publisher';
import type { ActivityService } from './activity-service';
import type { AuditService } from './audit-service';
import { auditContext, draftToInput, sessionLabel } from './labels';
import { logger } from './logger';
import type { MfaService } from './mfa-service';
import type { SessionService } from './session-service';
import type { TranscriptService } from './transcript-service';

export interface GrantServiceDeps {
  repos: Repos;
  audit: AuditService;
  publisher: Publisher;
  clock: Clock;
  providers: ProviderRegistry;
  mfa: MfaService;
  transcript: TranscriptService;
  activity: ActivityService;
  sessions: Pick<SessionService, 'applyEvent' | 'resolveAsk' | 'setNote'>;
  platform: NodeJS.Platform;
  /** `.styx/project.json` `policies.extra` for the target's project (ProjectService.projectRules); evaluated after app rules. */
  projectRules?: (projectId: string) => Policy[];
  /** Sweep interval after sleep; timers may lag (spec: 60 s). */
  sweepMs?: number;
}

export interface GrantRequest {
  sessionId: SessionId | null;
  targetId: TargetId;
  scope: Scope[];
  reason: string;
  /** "mcp:request_access" | "$ vercel deploy --prod" | "styx request …" */
  triggeredBy: string;
  worktreeId?: WorktreeId | null;
}

export type GrantOutcome =
  | { kind: 'active'; grant: Grant; decidedBy: NonNullable<Grant['decidedBy']> }
  | { kind: 'denied'; grant: Grant }
  | { kind: 'pending'; grant: Grant; ask: PendingAsk };

export type GrantListenerOutcome = 'granted' | 'denied' | 'cancelled' | 'revoked' | 'expired';
export type DecisionListener = (grant: Grant, outcome: GrantListenerOutcome) => void;

const HOUR = 3_600_000;
const SCOPE_SEP = '+';

/**
 * Grant lifecycle (plan §5): request → policy → auto-issue or ask; approve (MFA recomputed here from DB rows),
 * deny, revoke, use, expiry/idle timers + 60 s sweep. Every transition runs the core grant machine; effects
 * (credential issue/revoke, timers, audit, ask resolution, system message, notify) are executed here.
 */
export class GrantService {
  private readonly issued = new Map<string, IssuedCredential>();
  private readonly timers = new Map<string, { expiry?: NodeJS.Timeout; idle?: NodeJS.Timeout }>();
  private readonly idleMs = new Map<string, number | null>();
  private readonly listeners = new Set<DecisionListener>();
  private sweep: NodeJS.Timeout | null = null;

  constructor(private readonly deps: GrantServiceDeps) {}

  onDecision(fn: DecisionListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Arms timers for grants that were active at last shutdown and starts the sweep. */
  start(): void {
    for (const g of this.deps.repos.grants.active()) this.armTimers(g);
    this.sweep = setInterval(() => this.sweepExpired(), this.deps.sweepMs ?? 60_000);
    this.sweep.unref?.();
  }

  async stop(): Promise<void> {
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
    for (const t of this.timers.values()) {
      if (t.expiry) clearTimeout(t.expiry);
      if (t.idle) clearTimeout(t.idle);
    }
    this.timers.clear();
    for (const [id, cred] of this.issued) {
      await this.deps.providers
        .get(
          this.deps.repos.grants.get(id)
            ? (this.deps.repos.targets.get(this.deps.repos.grants.get(id)?.targetId ?? '')?.provider ??
                'vercel')
            : 'vercel',
        )
        .revoke(cred)
        .catch(() => undefined);
    }
    this.issued.clear();
  }

  get(id: string): Grant | null {
    return this.deps.repos.grants.get(id);
  }

  require(id: string): Grant {
    return this.deps.repos.grants.get(id) ?? fail('not-found', `grant ${id} not found`);
  }

  issuedCredential(grantId: string): IssuedCredential | null {
    return this.issued.get(grantId) ?? null;
  }

  /** The credential bundle for an active grant; re-issued through the adapter when the in-memory copy is gone (restart). */
  async credentialFor(grantId: string): Promise<IssuedCredential> {
    const cached = this.issued.get(grantId);
    if (cached) return cached;
    const grant = this.require(grantId);
    if (grant.state !== 'active') fail('invalid-transition', `grant is ${grant.state}`);
    const target = this.deps.repos.targets.get(grant.targetId) ?? fail('not-found', 'target not found');
    const info: GrantInfo = { id: grant.id, scope: [...grant.scope], duration: grant.duration, expiresAt: grant.expiresAt };
    const tinfo: TargetInfo = { id: target.id, provider: target.provider, name: target.name, env: target.env, config: target.config, credentialRef: target.credentialRef };
    const cred = await this.deps.providers.get(target.provider).issue(info, tinfo).catch((e: Error) => fail('provider-error', e.message));
    this.issued.set(grant.id, cred);
    return cred;
  }

  // --- request -------------------------------------------------------------

  decide(target: Target, session: Session | null, scope: Scope[]): PolicyDecision & { projectRuleId: string | null } {
    const { repos, clock } = this.deps;
    const d = evaluate({
      target,
      scope,
      session: session ? { id: session.id, mayRequestTargets: session.toggles.mayRequestTargets } : null,
      appRules: repos.policies.all(),
      projectRules: this.deps.projectRules?.(target.projectId) ?? [],
      persistentGrants: repos.grants.byTarget(target.id).filter((g) => g.state === 'active'),
      now: clock.now(),
    });
    // `.styx/project.json` rules are not `policies` rows (grants.policy_id is an FK): cite them in the audit detail instead.
    if (d.policyId !== null && !repos.policies.get(d.policyId)) return { ...d, policyId: null, projectRuleId: d.policyId };
    return { ...d, projectRuleId: null };
  }

  /** Any live grant of this session (or persistent on the target) covering `scope`. */
  covering(target: Target, sessionId: string | null, scope: readonly Scope[]): Grant | null {
    const now = this.deps.clock.now();
    return (
      this.deps.repos.grants
        .byTarget(target.id)
        .find(
          (g) => isLive(g, now) && covers(g, scope) && (g.sessionId === null || g.sessionId === sessionId),
        ) ?? null
    );
  }

  async request(req: GrantRequest): Promise<GrantOutcome> {
    const { repos, publisher, clock } = this.deps;
    const target = repos.targets.get(req.targetId) ?? fail('not-found', `target ${req.targetId} not found`);
    const session = req.sessionId ? repos.sessions.get(req.sessionId) : null;
    const now = clock.now();
    const decision = this.decide(target, session, req.scope);

    if (decision.decision === 'auto' && decision.grantId !== null) {
      const existing = repos.grants.get(decision.grantId);
      if (existing) return { kind: 'active', grant: existing, decidedBy: 'persistent-grant' };
    }

    const grant: Grant = {
      id: newId<'GrantId'>(),
      sessionId: session?.id ?? null,
      targetId: target.id,
      worktreeId: req.worktreeId ?? session?.worktreeId ?? null,
      scope: [...req.scope],
      duration: decision.decision === 'auto' ? decision.maxDuration : '1h',
      reason: req.reason,
      state: 'requested',
      requestedAt: now,
      issuedAt: null,
      expiresAt: null,
      lastUsedAt: null,
      idleExpiresAt: null,
      revokedAt: null,
      revokeReason: null,
      policyId: decision.policyId,
      mfaVerified: false,
      decidedBy: null,
    };
    repos.grants.upsert(grant);
    publisher.upsert('grants', [grant.id]);
    const actor = session
      ? { actorKind: 'agent' as const, actorLabel: AGENT_LABEL[session.agent] }
      : { actorKind: 'system' as const, actorLabel: 'system' };
    this.appendAudit({
      ...actor,
      action: 'requested',
      ...auditContext(repos, { session, target }),
      grantId: grant.id,
      policyId: decision.policyId,
      scope: grant.scope,
      triggeredBy: req.triggeredBy,
      detail: { reason: req.reason, ...(decision.projectRuleId ? { projectRule: decision.projectRuleId } : {}) },
    });

    if (decision.decision === 'deny') {
      const denied = this.apply(grant, { type: 'deny', triggeredBy: 'policy' });
      return { kind: 'denied', grant: denied };
    }
    if (decision.decision === 'auto') {
      const active = await this.issue(grant, {
        decidedBy: decision.decidedBy,
        duration: decision.maxDuration,
        mfaVerified: false,
        policyId: decision.policyId,
        idleMs: decision.idleMs,
        triggeredBy: req.triggeredBy,
      });
      if (decision.policyId) {
        repos.policies.bumpMatch(decision.policyId);
        publisher.upsert('policies', [decision.policyId]);
      }
      return { kind: 'active', grant: active, decidedBy: decision.decidedBy };
    }

    // ask: queue behind the session's open asks; the head is the only one surfaced.
    if (!session) fail('forbidden', 'a user decision needs a session');
    const ask: PendingAsk = {
      id: newId<'AskId'>(),
      sessionId: session.id,
      kind: 'grant',
      grantId: grant.id,
      payload: { kind: 'grant', grantId: grant.id },
      state: 'open',
      resolution: null,
      position: repos.pendingAsks.nextPosition(session.id),
      brokerRequestId: null,
      createdAt: now,
      resolvedAt: null,
    };
    repos.pendingAsks.upsert(ask);
    publisher.upsert('pendingAsks', [ask.id]);
    this.deps.transcript.append(
      session.id,
      fill(copy.accessRequest.scopeLine, {
        scopes: grant.scope.map((s) => copy.grantSheet.scopes[s].toLowerCase()).join(', '),
      }),
      {
        kind: 'access-request',
        targetId: target.id,
        targetLabel: `${target.name} ${target.env}`,
        scope: grant.scope,
        reason: req.reason,
        grantId: grant.id,
      },
      ask.id,
    );
    this.deps.sessions.setNote(
      session.id,
      `Requesting ${target.name} ${target.env} · ${grant.scope.join(' + ')}`,
    );
    this.deps.sessions.applyEvent(session.id, { type: 'ask', askId: ask.id });
    return { kind: 'pending', grant: this.require(grant.id), ask };
  }

  // --- user decisions ------------------------------------------------------

  /** `requireMfa` is recomputed from DB rows here; the renderer's opinion is never consulted (rules/security.md). */
  async approve(
    grantId: string,
    duration: Duration,
    scope?: Scope[],
    triggeredBy: string = copy.audit.triggeredBy.grantSheet,
  ): Promise<Grant> {
    const { repos } = this.deps;
    const grant = this.require(grantId);
    if (grant.state !== 'requested') fail('invalid-transition', `grant is ${grant.state}`);
    const target = repos.targets.get(grant.targetId) ?? fail('not-found', 'target not found');
    const session = grant.sessionId ? repos.sessions.get(grant.sessionId) : null;
    const scopes = scope && scope.length > 0 ? scope : grant.scope;
    if (scope && scope.length > 0 && !scope.every((s) => grant.scope.includes(s)))
      fail('invalid-input', 'scope must be a subset of the requested scope');
    const decision = this.decide(target, session, scopes);
    const needMfa = requiresMfa(target.env, scopes) || target.policy === 'ask-mfa' || decision.requireMfa;
    let mfaVerified = false;
    if (needMfa) {
      const reason = `Grant ${session ? AGENT_LABEL[session.agent] : 'access'} ${scopes.join('+')} on ${target.name} ${target.env}`;
      const r = await this.deps.mfa.verify(reason);
      if (r === 'unavailable')
        fail(
          'mfa-required',
          `${platformCopy(this.deps.platform === 'win32' ? 'win32' : 'darwin').mfa} is not available on this machine`,
        );
      if (r !== 'ok')
        fail('mfa-failed', r === 'cancelled' ? 'verification cancelled' : 'verification failed');
      mfaVerified = true;
    }
    if (scopes !== grant.scope) {
      repos.grants.upsert({ ...grant, scope: [...scopes] });
    }
    return this.issue(this.require(grant.id), {
      decidedBy: 'user',
      duration,
      mfaVerified,
      policyId: decision.policyId,
      idleMs: decision.idleMs,
      triggeredBy,
    });
  }

  deny(grantId: string, triggeredBy: string = copy.audit.triggeredBy.grantSheet): Grant {
    const grant = this.require(grantId);
    if (grant.state !== 'requested') fail('invalid-transition', `grant is ${grant.state}`);
    return this.apply(grant, { type: 'deny', triggeredBy });
  }

  revoke(
    grantId: string,
    triggeredBy: string = copy.audit.triggeredBy.lockGlyph,
    reason: 'user' | 'session-end' | 'target-removed' | 'policy' = 'user',
  ): Grant {
    const grant = this.require(grantId);
    // Spec §1: the only user path out of `requested` is deny; system cancels keep their reason.
    if (grant.state === 'requested') {
      if (reason === 'user') return this.deny(grantId, triggeredBy);
      return this.apply(grant, { type: 'cancel', reason: reason === 'target-removed' ? 'target-removed' : 'session-end' });
    }
    if (grant.state !== 'active') fail('invalid-transition', `grant is ${grant.state}`);
    return this.apply(grant, { type: 'revoke', reason, triggeredBy });
  }

  expire(grantId: string, reason: 'expired' | 'idle'): Grant | null {
    const grant = this.get(grantId);
    if (!grant || grant.state !== 'active') return grant;
    return this.apply(grant, { type: 'expire', reason });
  }

  /** Records a use (shim exec / credential fetch / ssh sign); `once` grants are revoked after their first use. */
  use(
    grantId: string,
    opts: { command: string | null; scopeUsed: Scope; via: GrantUseVia; sessionId: string | null },
  ): { grant: Grant; useId: string } {
    const grant = this.require(grantId);
    if (grant.state !== 'active') fail('invalid-transition', `grant is ${grant.state}`);
    const useId = newId<'UseId'>();
    this.deps.repos.grantUses.insert({
      id: useId,
      grantId: grant.id,
      sessionId: opts.sessionId === null ? null : idFrom<'SessionId'>(opts.sessionId),
      via: opts.via,
      command: opts.command,
      scopeUsed: opts.scopeUsed,
      exitCode: null,
      startedAt: this.deps.clock.now(),
      endedAt: null,
    });
    const next = this.apply(grant, { type: 'use', command: opts.command, scopeUsed: opts.scopeUsed }, opts.sessionId);
    return { grant: next, useId };
  }

  endUse(useId: string, exitCode: number): void {
    this.deps.repos.grantUses.end(useId, exitCode, this.deps.clock.now());
  }

  /** Session end: open requests are cancelled, active grants revoked (`always` grants are detached and survive). */
  cancelSessionGrants(sessionId: string): void {
    for (const g of this.deps.repos.grants.bySession(sessionId)) {
      if (g.state === 'requested') this.apply(g, { type: 'cancel', reason: 'session-end' });
      else if (g.state === 'active')
        this.apply(g, { type: 'revoke', reason: 'session-end', triggeredBy: 'session end' });
    }
  }

  cancelTargetGrants(targetId: string): void {
    for (const g of this.deps.repos.grants.byTarget(targetId)) {
      if (g.state === 'requested') this.apply(g, { type: 'cancel', reason: 'target-removed' });
      else if (g.state === 'active')
        this.apply(g, { type: 'revoke', reason: 'target-removed', triggeredBy: 'target removed' });
    }
  }

  sweepExpired(): void {
    const now = this.deps.clock.now();
    for (const g of this.deps.repos.grants.active()) {
      const why = shouldExpire(g, now);
      if (why) this.expire(g.id, why);
    }
  }

  // --- machine plumbing ----------------------------------------------------

  /** `usingSessionId` attributes a use of a detached (`always`) grant to the session that used it. */
  private context(grant: Grant, usingSessionId: string | null = null): GrantContext {
    const { repos } = this.deps;
    const target = repos.targets.get(grant.targetId);
    const session = grant.sessionId ? repos.sessions.get(grant.sessionId) : usingSessionId ? repos.sessions.get(usingSessionId) : null;
    const project = session ? repos.projects.get(session.projectId) : null;
    const worktree = grant.worktreeId ? repos.worktrees.get(grant.worktreeId) : null;
    return {
      now: this.deps.clock.now(),
      grant,
      target: { env: target?.env ?? 'prod', label: target ? targetLabel(target) : 'target' },
      session: session
        ? {
            id: session.id,
            agent: session.agent,
            label: sessionLabel(session, project?.name ?? 'project'),
            worktreeLabel: worktree?.branch ?? null,
          }
        : null,
      projectId: session?.projectId ?? target?.projectId ?? null,
      idleMs: this.idleMs.get(grant.id) ?? null,
    };
  }

  private async issue(
    grant: Grant,
    opts: {
      decidedBy: NonNullable<Grant['decidedBy']>;
      duration: Duration;
      mfaVerified: boolean;
      policyId: Grant['policyId'];
      idleMs: number | null;
      triggeredBy: string;
    },
  ): Promise<Grant> {
    const { repos } = this.deps;
    const target = repos.targets.get(grant.targetId) ?? fail('not-found', 'target not found');
    const ctx = this.context(grant);
    const event: GrantEvent = {
      type: 'issue',
      decidedBy: opts.decidedBy,
      duration: opts.duration,
      mfaVerified: opts.mfaVerified,
      policyId: opts.policyId,
      idleMs: opts.idleMs,
      triggeredBy: opts.triggeredBy,
    };
    const t = grantTransition(grant.state, event, ctx);
    if (t === null) fail('mfa-required', 'prod write requires verification');
    this.idleMs.set(grant.id, opts.idleMs);
    // Credentials are issued before the row flips to active so a provider failure leaves the request open.
    const expiresAt = t.patch.expiresAt ?? null;
    const info: GrantInfo = { id: grant.id, scope: [...grant.scope], duration: opts.duration, expiresAt };
    const tinfo: TargetInfo = {
      id: target.id,
      provider: target.provider,
      name: target.name,
      env: target.env,
      config: target.config,
      credentialRef: target.credentialRef,
    };
    let cred: IssuedCredential;
    try {
      cred = await this.deps.providers.get(target.provider).issue(info, tinfo);
    } catch (e) {
      fail('provider-error', (e as Error).message);
    }
    this.issued.set(grant.id, cred);
    repos.grants.setCredNonce(grant.id, randomBytes(16).toString('hex'));
    const next = this.commit(grant, t.state, t.patch, t.effects);
    // Chat system line (spec §10): "grant: supabase-prod · read+write · expires in 59m".
    if (next.sessionId ?? grant.sessionId) {
      const until = openUntil(next);
      const body =
        until === null
          ? fill(copy.grantResult.linePersistent, {
              target: ctx.target.label,
              scopes: next.scope.join(SCOPE_SEP),
            })
          : fill(copy.grantResult.line, {
              target: ctx.target.label,
              scopes: next.scope.join(SCOPE_SEP),
              t: formatCountdown(until - ctx.now),
            });
      this.deps.transcript.system((next.sessionId ?? grant.sessionId) as SessionId, body);
      this.deps.sessions.setNote((next.sessionId ?? grant.sessionId) as SessionId, null);
    }
    return next;
  }

  private apply(grant: Grant, event: Exclude<GrantEvent, { type: 'issue' }>, usingSessionId: string | null = null): Grant {
    const ctx = this.context(grant, usingSessionId);
    const t = grantTransition(grant.state, event, ctx);
    if (t === null) fail('invalid-transition', `${event.type} is not valid while ${grant.state}`);
    return this.commit(grant, t.state, t.patch, t.effects);
  }

  private commit(
    grant: Grant,
    state: Grant['state'],
    patch: Partial<Grant> & { sessionId?: null },
    effects: GrantEffect[],
  ): Grant {
    const { repos, publisher } = this.deps;
    const next: Grant = { ...grant, ...patch, state };
    const auditIds: string[] = [];
    repos.transaction(() => {
      repos.grants.upsert(next);
      for (const e of effects) if (e.type === 'appendAudit') auditIds.push(this.deps.audit.append(draftToInput(e.entry)).id);
    });
    publisher.upsert('auditEntries', auditIds);
    for (const id of auditIds) {
      const row = repos.audit.get(id);
      if (row) this.deps.activity.fromAudit(row);
    }
    publisher.upsert('grants', [next.id]);
    if (next.targetId) publisher.upsert('targets', [next.targetId]);
    for (const e of effects) {
      if (e.type === 'appendAudit') continue;
      this.runEffect(e, next);
    }
    return next;
  }

  private runEffect(e: GrantEffect, grant: Grant): void {
    const { publisher } = this.deps;
    switch (e.type) {
      case 'issueCredential':
        return; // done ahead of commit in `issue`
      case 'revokeCredential': {
        for (const fn of this.listeners) fn(grant, grant.state === 'expired' ? 'expired' : 'revoked');
        const cred = this.issued.get(grant.id);
        this.issued.delete(grant.id);
        this.deps.repos.grants.setCredNonce(grant.id, null);
        if (cred) {
          const target = this.deps.repos.targets.get(grant.targetId);
          if (target)
            void this.deps.providers
              .get(target.provider)
              .revoke(cred)
              .catch((err: Error) =>
                logger.warn('grant: revoke credential failed', { grantId: grant.id, error: err.message }),
              );
        }
        return;
      }
      case 'startExpiryTimer':
        this.armTimer(grant.id, 'expiry', e.at);
        return;
      case 'startIdleTimer':
        this.armTimer(grant.id, 'idle', e.at);
        return;
      case 'cancelTimers':
        this.clearTimers(grant.id);
        this.idleMs.delete(grant.id);
        return;
      case 'appendAudit':
        return;
      case 'postSystemMessage':
        this.deps.transcript.system(e.sessionId, e.body);
        return;
      case 'notify': {
        publisher.sendEvent('grant.result', {
          grantId: grant.id,
          sessionId: e.sessionId,
          outcome: e.outcome,
        });
        return;
      }
      case 'resolveAsk': {
        const ask = this.deps.repos.pendingAsks.byGrant(grant.id);
        if (ask && ask.state === 'open') {
          if (e.outcome === 'cancelled') {
            const now = this.deps.clock.now();
            this.deps.repos.pendingAsks.upsert({ ...ask, state: 'cancelled', resolvedAt: now });
            publisher.upsert('pendingAsks', [ask.id]);
            this.deps.sessions.applyEvent(ask.sessionId, { type: 'ask-resolved', askId: ask.id });
          } else {
            this.deps.sessions.resolveAsk(ask.id, { kind: 'grant', outcome: e.outcome });
          }
        }
        for (const fn of this.listeners) fn(grant, e.outcome);
        return;
      }
      case 'detachSession':
        return; // patch.sessionId = null already committed
    }
  }

  private armTimers(g: Grant): void {
    if (g.expiresAt !== null) this.armTimer(g.id, 'expiry', g.expiresAt);
    if (g.idleExpiresAt !== null) this.armTimer(g.id, 'idle', g.idleExpiresAt);
  }

  private armTimer(grantId: string, kind: 'expiry' | 'idle', at: number): void {
    const cur = this.timers.get(grantId) ?? {};
    const prev = cur[kind];
    if (prev) clearTimeout(prev);
    const delay = Math.max(0, Math.min(at - this.deps.clock.now(), 24 * HOUR));
    const t = setTimeout(() => {
      const g = this.get(grantId);
      if (!g || g.state !== 'active') return;
      const why = shouldExpire(g, this.deps.clock.now());
      if (why) this.expire(grantId, why);
      else this.armTimers(g); // clock drifted (sleep): re-arm from the row
    }, delay);
    t.unref?.();
    cur[kind] = t;
    this.timers.set(grantId, cur);
  }

  private clearTimers(grantId: string): void {
    const cur = this.timers.get(grantId);
    if (cur?.expiry) clearTimeout(cur.expiry);
    if (cur?.idle) clearTimeout(cur.idle);
    this.timers.delete(grantId);
  }

  private appendAudit(input: Parameters<AuditService['append']>[0]): void {
    const row = this.deps.audit.append(input);
    this.deps.publisher.upsert('auditEntries', [row.id]);
    const entry = this.deps.repos.audit.get(row.id);
    if (entry) this.deps.activity.fromAudit(entry);
  }

  /** Pending grant asks for a session (used by the broker to compute queue positions). */
  queuePosition(askId: AskId | string): number {
    const ask = this.deps.repos.pendingAsks.get(askId);
    if (!ask) return 0;
    return this.deps.repos.pendingAsks.openBySession(ask.sessionId).findIndex((a) => a.id === ask.id);
  }

  grantIdOfAsk(askId: string): GrantId | null {
    return this.deps.repos.pendingAsks.get(askId)?.grantId ?? null;
  }
}

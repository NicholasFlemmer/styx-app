import type { GrantId, PolicyId, SessionId } from '../ids';
import type { AuditDraft } from '../model/audit';
import type { Duration, Env, Scope } from '../model/common';
import type { DecidedBy, Grant, GrantState, RevokeReason } from '../model/grant';

export const HOUR_MS = 60 * 60 * 1000;
export const WRITE_SCOPES: readonly Scope[] = ['write', 'deploy', 'delete'];

/** Spec §1: MFA when env = prod and scope ∋ write | deploy | delete. Not disableable. */
export const requiresMfa = (env: Env, scopes: readonly Scope[]): boolean =>
  env === 'prod' && scopes.some((s) => WRITE_SCOPES.includes(s));

export type GrantEvent =
  | {
      type: 'issue';
      decidedBy: DecidedBy;
      duration: Duration;
      mfaVerified: boolean;
      policyId: PolicyId | null;
      /** Idle expiry from the policy engine; null = no idle expiry. */
      idleMs: number | null;
      triggeredBy: string;
    }
  | { type: 'deny'; triggeredBy: string }
  | { type: 'cancel'; reason: Extract<RevokeReason, 'session-end' | 'target-removed'> }
  | { type: 'use'; command: string | null; scopeUsed: Scope }
  | {
      type: 'revoke';
      reason: Extract<RevokeReason, 'user' | 'session-end' | 'target-removed' | 'policy'>;
      triggeredBy: string;
    }
  | { type: 'expire'; reason: Extract<RevokeReason, 'expired' | 'idle'> };

export type GrantEventType = GrantEvent['type'];

export type GrantEffect =
  | { type: 'issueCredential'; grantId: GrantId }
  | { type: 'revokeCredential'; grantId: GrantId }
  | { type: 'startExpiryTimer'; grantId: GrantId; at: number }
  | { type: 'startIdleTimer'; grantId: GrantId; at: number }
  | { type: 'cancelTimers'; grantId: GrantId }
  | { type: 'appendAudit'; entry: AuditDraft }
  | { type: 'postSystemMessage'; sessionId: SessionId; body: string }
  | { type: 'notify'; sessionId: SessionId; grantId: GrantId; outcome: 'granted' | 'denied' }
  | { type: 'resolveAsk'; grantId: GrantId; outcome: 'granted' | 'denied' | 'cancelled' }
  | { type: 'detachSession'; grantId: GrantId };

export interface GrantContext {
  now: number;
  grant: Pick<
    Grant,
    | 'id'
    | 'sessionId'
    | 'targetId'
    | 'worktreeId'
    | 'scope'
    | 'duration'
    | 'reason'
    | 'expiresAt'
    | 'idleExpiresAt'
    | 'policyId'
  >;
  target: { env: Env; label: string };
  session: { id: SessionId; agent: AuditDraft['agent']; label: string; worktreeLabel: string | null } | null;
  projectId: AuditDraft['projectId'];
  /** Idle window carried over from issuance so `use` can re-arm the idle timer. */
  idleMs: number | null;
}

/** Fields main writes back on the grant row. */
export interface GrantPatch {
  duration?: Duration;
  issuedAt?: number;
  expiresAt?: number | null;
  idleExpiresAt?: number | null;
  lastUsedAt?: number;
  revokedAt?: number;
  revokeReason?: RevokeReason;
  policyId?: PolicyId | null;
  mfaVerified?: boolean;
  decidedBy?: DecidedBy;
  sessionId?: null;
}

export interface GrantTransition {
  state: GrantState;
  patch: GrantPatch;
  effects: GrantEffect[];
}

type Cell<E extends GrantEvent> = (event: E, ctx: GrantContext) => GrantTransition | null;
type Row = { [E in GrantEvent as E['type']]: Cell<E> };

const invalid = (): null => null;

/** `once` is capped at 1h as a safety net; `session` ends with the session; `always` never expires. */
export const expiresAtFor = (duration: Duration, now: number): number | null =>
  duration === 'once' || duration === '1h' ? now + HOUR_MS : null;

export const idleExpiresAtFor = (duration: Duration, idleMs: number | null, now: number): number | null =>
  duration === 'always' || idleMs === null ? null : now + idleMs;

/** "open until" = the earlier of hard expiry and idle expiry; null = persistent. */
export const openUntil = (grant: Pick<Grant, 'expiresAt' | 'idleExpiresAt'>): number | null => {
  if (grant.expiresAt === null) return grant.idleExpiresAt;
  if (grant.idleExpiresAt === null) return grant.expiresAt;
  return Math.min(grant.expiresAt, grant.idleExpiresAt);
};

/** Sweep helper for timers after sleep: which expiry (if any) has passed. `always` never expires. */
export const shouldExpire = (
  grant: Pick<Grant, 'state' | 'duration' | 'expiresAt' | 'idleExpiresAt'>,
  now: number,
): Extract<RevokeReason, 'expired' | 'idle'> | null => {
  if (grant.state !== 'active' || grant.duration === 'always') return null;
  if (grant.expiresAt !== null && grant.expiresAt <= now) return 'expired';
  if (grant.idleExpiresAt !== null && grant.idleExpiresAt <= now) return 'idle';
  return null;
};

const audit = (
  ctx: GrantContext,
  action: AuditDraft['action'],
  actor: { kind: AuditDraft['actorKind']; label: string },
  extra: Partial<AuditDraft>,
): GrantEffect => ({
  type: 'appendAudit',
  entry: {
    time: ctx.now,
    actorKind: actor.kind,
    actorLabel: actor.label,
    action,
    projectId: ctx.projectId,
    targetId: ctx.grant.targetId,
    sessionId: ctx.session?.id ?? null,
    worktreeId: ctx.grant.worktreeId,
    grantId: ctx.grant.id,
    policyId: ctx.grant.policyId,
    targetLabel: ctx.target.label,
    sessionLabel: ctx.session?.label ?? null,
    worktreeLabel: ctx.session?.worktreeLabel ?? null,
    agent: ctx.session?.agent ?? null,
    scope: [...ctx.grant.scope],
    duration: ctx.grant.duration,
    triggeredBy: null,
    detail: {},
    ...extra,
  },
});

const systemActor = { kind: 'system', label: 'system' } as const;
const youActor = { kind: 'you', label: 'you' } as const;
const agentActor = (ctx: GrantContext): { kind: AuditDraft['actorKind']; label: string } =>
  ctx.session === null ? systemActor : { kind: 'agent', label: ctx.session.label };

const issue: Cell<Extract<GrantEvent, { type: 'issue' }>> = (event, ctx) => {
  if (requiresMfa(ctx.target.env, ctx.grant.scope) && !event.mfaVerified) return null;
  const expiresAt = expiresAtFor(event.duration, ctx.now);
  const idleExpiresAt = idleExpiresAtFor(event.duration, event.idleMs, ctx.now);
  const actor = event.decidedBy === 'user' ? youActor : systemActor;
  const effects: GrantEffect[] = [{ type: 'issueCredential', grantId: ctx.grant.id }];
  if (expiresAt !== null) effects.push({ type: 'startExpiryTimer', grantId: ctx.grant.id, at: expiresAt });
  if (idleExpiresAt !== null)
    effects.push({ type: 'startIdleTimer', grantId: ctx.grant.id, at: idleExpiresAt });
  if (event.duration === 'always') effects.push({ type: 'detachSession', grantId: ctx.grant.id });
  effects.push(
    audit(ctx, 'granted', actor, {
      duration: event.duration,
      policyId: event.policyId,
      triggeredBy: event.triggeredBy,
      detail: { decidedBy: event.decidedBy, mfaVerified: event.mfaVerified },
    }),
    { type: 'resolveAsk', grantId: ctx.grant.id, outcome: 'granted' },
  );
  if (ctx.session !== null) {
    effects.push({ type: 'notify', sessionId: ctx.session.id, grantId: ctx.grant.id, outcome: 'granted' });
  }
  const patch: GrantPatch = {
    duration: event.duration,
    issuedAt: ctx.now,
    expiresAt,
    idleExpiresAt,
    policyId: event.policyId,
    mfaVerified: event.mfaVerified,
    decidedBy: event.decidedBy,
  };
  if (event.duration === 'always') patch.sessionId = null;
  return { state: 'active', patch, effects };
};

const deny: Cell<Extract<GrantEvent, { type: 'deny' }>> = (event, ctx) => {
  const effects: GrantEffect[] = [
    audit(ctx, 'denied', youActor, { triggeredBy: event.triggeredBy }),
    { type: 'resolveAsk', grantId: ctx.grant.id, outcome: 'denied' },
  ];
  if (ctx.session !== null) {
    effects.push({ type: 'notify', sessionId: ctx.session.id, grantId: ctx.grant.id, outcome: 'denied' });
  }
  return { state: 'denied', patch: { revokedAt: ctx.now }, effects };
};

/**
 * A request withdrawn before anyone answered it (session ended, target removed) ends as `denied`, not `revoked`:
 * nothing was ever issued, and the store's invariant (`revoked`/`active`/`expired` ⇔ `issuedAt` set) holds.
 */
const cancel: Cell<Extract<GrantEvent, { type: 'cancel' }>> = (event, ctx) => ({
  state: 'denied',
  patch: { revokedAt: ctx.now, revokeReason: event.reason },
  effects: [
    audit(ctx, 'revoked', systemActor, { detail: { reason: event.reason } }),
    { type: 'resolveAsk', grantId: ctx.grant.id, outcome: 'cancelled' },
  ],
});

const revokeEffects = (
  ctx: GrantContext,
  reason: RevokeReason,
  actor: { kind: AuditDraft['actorKind']; label: string },
  triggeredBy: string | null,
): GrantEffect[] => [
  { type: 'revokeCredential', grantId: ctx.grant.id },
  { type: 'cancelTimers', grantId: ctx.grant.id },
  audit(ctx, reason === 'expired' || reason === 'idle' ? 'expired' : 'revoked', actor, {
    triggeredBy,
    detail: { reason },
  }),
];

const use: Cell<Extract<GrantEvent, { type: 'use' }>> = (event, ctx) => {
  const used = audit(ctx, 'used', agentActor(ctx), {
    triggeredBy: event.command,
    scope: [event.scopeUsed],
    detail: { via: event.command === null ? 'get_credential' : 'shim' },
  });
  if (ctx.grant.duration === 'once') {
    return {
      state: 'revoked',
      patch: { lastUsedAt: ctx.now, revokedAt: ctx.now, revokeReason: 'once-used' },
      effects: [used, ...revokeEffects(ctx, 'once-used', systemActor, null)],
    };
  }
  const idleExpiresAt = idleExpiresAtFor(ctx.grant.duration, ctx.idleMs, ctx.now);
  const effects: GrantEffect[] = [used];
  if (idleExpiresAt !== null)
    effects.push({ type: 'startIdleTimer', grantId: ctx.grant.id, at: idleExpiresAt });
  return { state: 'active', patch: { lastUsedAt: ctx.now, idleExpiresAt }, effects };
};

const revoke: Cell<Extract<GrantEvent, { type: 'revoke' }>> = (event, ctx) => ({
  state: 'revoked',
  patch: { revokedAt: ctx.now, revokeReason: event.reason },
  effects: revokeEffects(
    ctx,
    event.reason,
    event.reason === 'user' ? youActor : systemActor,
    event.triggeredBy,
  ),
});

/** `always` never expires (spec §1); an expire event for it is invalid. */
const expire: Cell<Extract<GrantEvent, { type: 'expire' }>> = (event, ctx) => {
  if (ctx.grant.duration === 'always') return null;
  return {
    state: 'expired',
    patch: { revokedAt: ctx.now, revokeReason: event.reason },
    effects: revokeEffects(
      ctx,
      event.reason,
      systemActor,
      event.reason === 'idle' ? 'idle timer' : 'expiry timer',
    ),
  };
};

const TABLE: Record<GrantState, Row> = {
  requested: { issue, deny, cancel, use: invalid, revoke: invalid, expire: invalid },
  active: { issue: invalid, deny: invalid, cancel: invalid, use, revoke, expire },
  denied: { issue: invalid, deny: invalid, cancel: invalid, use: invalid, revoke: invalid, expire: invalid },
  revoked: { issue: invalid, deny: invalid, cancel: invalid, use: invalid, revoke: invalid, expire: invalid },
  expired: { issue: invalid, deny: invalid, cancel: invalid, use: invalid, revoke: invalid, expire: invalid },
};

export const transition = (
  state: GrantState,
  event: GrantEvent,
  ctx: GrantContext,
): GrantTransition | null => {
  const cell = TABLE[state][event.type] as Cell<GrantEvent>;
  return cell(event, ctx);
};

export const GRANT_STATES: readonly GrantState[] = ['requested', 'active', 'denied', 'revoked', 'expired'];
export const GRANT_EVENT_TYPES: readonly GrantEventType[] = [
  'issue',
  'deny',
  'cancel',
  'use',
  'revoke',
  'expire',
];

/** Whether an active grant covers every requested scope. */
export const covers = (grant: Pick<Grant, 'state' | 'scope'>, scopes: readonly Scope[]): boolean =>
  grant.state === 'active' && scopes.every((s) => grant.scope.includes(s));

/** Live = active and not past its open-until instant (timers may lag after sleep). */
export const isLive = (grant: Pick<Grant, 'state' | 'expiresAt' | 'idleExpiresAt'>, now: number): boolean => {
  if (grant.state !== 'active') return false;
  const until = openUntil(grant);
  return until === null || until > now;
};

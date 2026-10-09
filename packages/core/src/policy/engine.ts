import type { GrantId, PolicyId } from '../ids';
import { covers, isLive, requiresMfa } from '../machines/grant';
import type { Duration, Env, Scope, TargetPolicy } from '../model/common';
import type { DecidedBy, Grant } from '../model/grant';
import type { Policy, PolicyRule, TargetMatch } from '../model/policy';
import type { Target } from '../model/target';

export interface PolicyInput {
  target: Pick<Target, 'id' | 'provider' | 'env' | 'policy'>;
  scope: readonly Scope[];
  /**
   * Whether the target's adapter hands out a credential narrower than the stored one for these scopes
   * (`ProviderAdapter.issuesScoped`; absent there = false). Main reads it from the adapter, never from the renderer.
   */
  credentialScoped: boolean;
  /** The requesting session, when any (shims from a shell session still have one). */
  session: { id: string; mayRequestTargets: boolean } | null;
  /** App-level rules, evaluated by `ord`. */
  appRules: readonly Policy[];
  /** `.styx/project.json` `policies.extra`, evaluated after app rules. */
  projectRules: readonly Policy[];
  /** Active grants on this target (any session); an `always` grant covering the scope short-circuits. */
  persistentGrants: readonly Grant[];
  now: number;
}

export interface PolicyDecision {
  decision: 'auto' | 'ask' | 'deny';
  decidedBy: DecidedBy;
  requireMfa: boolean;
  maxDuration: Duration;
  /**
   * True when `maxDuration` was cut to `once` because this is a production write, deploy or delete on a target
   * whose credential is not narrowed per grant (issue #29): every such command is its own verified decision.
   */
  onceOnly: boolean;
  idleMs: number | null;
  policyId: PolicyId | null;
  /** Set when an existing grant already covers the request. */
  grantId: GrantId | null;
}

export const DEFAULT_IDLE_MS = 60 * 60 * 1000;

/** Durations from shortest to longest; the grant sheet lists them in this order. */
export const DURATION_ORDER: readonly Duration[] = ['once', '1h', 'session', 'always'];

/**
 * Prod ∧ write/deploy/delete on a target whose credential is not narrowed per grant: the agent gets the whole stored
 * token, so a standing grant would let every later production command through unasked. Capped at `once`.
 */
export const onceOnly = (env: Env, scope: readonly Scope[], credentialScoped: boolean): boolean =>
  !credentialScoped && requiresMfa(env, scope);

/** The longest duration a person may approve for this request: `once` when `onceOnly`, else anything. */
export const maxGrantDuration = (env: Env, scope: readonly Scope[], credentialScoped: boolean): Duration =>
  onceOnly(env, scope, credentialScoped) ? 'once' : 'always';

/** `want`, or `max` when `want` is longer. */
export const clampDuration = (want: Duration, max: Duration): Duration =>
  DURATION_ORDER.indexOf(want) > DURATION_ORDER.indexOf(max) ? max : want;

/** Durations up to and including `max`, shortest first. */
export const allowedDurations = (max: Duration): Duration[] =>
  DURATION_ORDER.filter((d) => DURATION_ORDER.indexOf(d) <= DURATION_ORDER.indexOf(max));

/**
 * Whether approving needs OS authentication, from facts the renderer also holds: prod write/deploy/delete (spec §1),
 * an `ask-mfa` target, or any prod scope on a target whose credential is not narrowed per grant (the agent would get
 * the whole token whatever the scope heuristics said). Ask rules may add MFA on top (`PolicyDecision.requireMfa`).
 */
export const approvalNeedsMfa = (
  target: { env: Env; policy: TargetPolicy },
  scope: readonly Scope[],
  credentialScoped: boolean,
): boolean =>
  requiresMfa(target.env, scope) ||
  target.policy === 'ask-mfa' ||
  (target.env === 'prod' && !credentialScoped);

export const matchesTarget = (
  match: TargetMatch,
  target: Pick<Target, 'id' | 'provider' | 'env'>,
): boolean => {
  if (match.provider !== undefined && !match.provider.includes(target.provider)) return false;
  if (match.env !== undefined && !match.env.includes(target.env)) return false;
  if (match.targetIds !== undefined && !match.targetIds.includes(target.id)) return false;
  return true;
};

const scopesCovered = (ruleScopes: readonly Scope[], requested: readonly Scope[]): boolean =>
  requested.every((s) => ruleScopes.includes(s));
const scopesOverlap = (ruleScopes: readonly Scope[], requested: readonly Scope[]): boolean =>
  requested.some((s) => ruleScopes.includes(s));

const byOrd = (a: Policy, b: Policy): number => a.ord - b.ord;

type RuleHit = { policy: Policy; rule: PolicyRule };

/**
 * Rules top-to-bottom: persistent grant → target policy `always` → app rules by ord → project rules →
 * default ask. `requireMfa` is forced for prod ∧ write/deploy/delete, and for any prod scope when the credential is
 * not narrowed per grant; a forced-MFA request can only be auto-approved by a grant that already exists (which was
 * MFA-verified when issued). A `onceOnly` request (prod write on an unscoped credential) is never auto-approved, not
 * even by an existing `always` grant, and every answer it gets is capped at `once`.
 */
export const evaluate = (input: PolicyInput): PolicyDecision => {
  const { target, scope } = input;
  const forcedMfa = requiresMfa(target.env, scope) || (target.env === 'prod' && !input.credentialScoped);
  const once = onceOnly(target.env, scope, input.credentialScoped);
  const cap = (d: Duration): Duration => (once ? 'once' : d);
  const enabled = (rules: readonly Policy[]): Policy[] => rules.filter((p) => p.enabled).sort(byOrd);
  const ordered = [...enabled(input.appRules), ...enabled(input.projectRules)];

  const idleHit = ordered.find(
    (p): p is Policy & { rule: Extract<PolicyRule, { kind: 'idle-expiry' }> } =>
      p.rule.kind === 'idle-expiry' && matchesTarget(p.rule.match, target),
  );
  const idleMs = idleHit === undefined ? null : idleHit.rule.idleMs;

  const base = {
    requireMfa: forcedMfa || target.policy === 'ask-mfa',
    onceOnly: once,
    idleMs,
    policyId: null,
    grantId: null,
  } as const;

  if (input.session !== null && !input.session.mayRequestTargets) {
    return { ...base, decision: 'deny', decidedBy: 'policy', maxDuration: 'once' };
  }

  const persistent = input.persistentGrants.find(
    (g) =>
      !once &&
      g.targetId === target.id &&
      g.duration === 'always' &&
      isLive(g, input.now) &&
      covers(g, scope),
  );
  if (persistent !== undefined) {
    return {
      ...base,
      decision: 'auto',
      decidedBy: 'persistent-grant',
      requireMfa: false,
      maxDuration: 'always',
      grantId: persistent.id,
    };
  }

  if (target.policy === 'always' && !forcedMfa) {
    return { ...base, decision: 'auto', decidedBy: 'target-policy', maxDuration: 'always' };
  }

  const hit = ordered
    .map((policy): RuleHit => ({ policy, rule: policy.rule }))
    .find(({ rule }) => {
      if (!matchesTarget(rule.match, target)) return false;
      if (rule.kind === 'auto-approve') return scopesCovered(rule.scopes, scope);
      if (rule.kind === 'ask') return scopesOverlap(rule.scopes, scope);
      return false;
    });

  if (hit !== undefined && hit.rule.kind === 'auto-approve' && !forcedMfa && target.policy !== 'ask-mfa') {
    return {
      ...base,
      decision: 'auto',
      decidedBy: 'policy',
      maxDuration: hit.rule.duration,
      policyId: hit.policy.id,
    };
  }
  if (hit !== undefined && hit.rule.kind === 'ask') {
    return {
      ...base,
      decision: 'ask',
      decidedBy: 'user',
      requireMfa: base.requireMfa || hit.rule.requireMfa,
      maxDuration: cap('always'),
      policyId: hit.policy.id,
    };
  }
  if (hit !== undefined) {
    // auto-approve rule matched but MFA is forced: the user must approve with MFA; the rule is still cited.
    return {
      ...base,
      decision: 'ask',
      decidedBy: 'user',
      requireMfa: true,
      maxDuration: cap('always'),
      policyId: hit.policy.id,
    };
  }
  return { ...base, decision: 'ask', decidedBy: 'user', maxDuration: cap('always') };
};

/** Alias used by the package docs (`evaluatePolicies()`); same function. */
export const evaluatePolicies = evaluate;

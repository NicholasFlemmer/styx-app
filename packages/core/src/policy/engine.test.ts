import { describe, expect, it } from 'vitest';
import { idFrom } from '../ids';
import type { GrantId, PolicyId, TargetId } from '../ids';
import type { Grant } from '../model/grant';
import type { Scope } from '../model/common';
import type { Policy, TargetMatch } from '../model/policy';
import type { Target } from '../model/target';
import { BUILTIN_POLICY_IDS, defaultPolicies, policyRuleText } from './defaults';
import {
  DEFAULT_IDLE_MS,
  DURATION_ORDER,
  allowedDurations,
  approvalNeedsMfa,
  clampDuration,
  evaluate,
  evaluatePolicies,
  matchesTarget,
  maxGrantDuration,
  onceOnly,
} from './engine';
import type { PolicyInput } from './engine';

const NOW = 1_700_000_000_000;
const targetId = idFrom<'TargetId'>('tgt-1') as TargetId;

const target = (over: Partial<PolicyInput['target']> = {}): PolicyInput['target'] => ({
  id: targetId,
  provider: 'supabase',
  env: 'prod',
  policy: 'ask',
  ...over,
});

const input = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  target: target(),
  scope: ['read'],
  credentialScoped: true,
  session: { id: 's1', mayRequestTargets: true },
  appRules: defaultPolicies(),
  projectRules: [],
  persistentGrants: [],
  now: NOW,
  ...over,
});

const policy = (id: string, ord: number, rule: Policy['rule'], enabled = true): Policy => ({
  id: idFrom<'PolicyId'>(id) as PolicyId,
  ord,
  rule,
  ruleText: id,
  enabled,
  builtinKey: null,
  matchCountToday: 0,
  matchCountWeek: 0,
  countersResetAt: null,
  createdAt: 0,
});

const alwaysGrant = (over: Partial<Grant> = {}): Grant => ({
  id: idFrom<'GrantId'>('g-always') as GrantId,
  sessionId: null,
  targetId,
  worktreeId: null,
  scope: ['read', 'deploy'],
  duration: 'always',
  reason: 'preview deploys',
  state: 'active',
  requestedAt: 0,
  issuedAt: 0,
  expiresAt: null,
  lastUsedAt: null,
  idleExpiresAt: null,
  revokedAt: null,
  revokeReason: null,
  policyId: null,
  mfaVerified: true,
  decidedBy: 'user',
  ...over,
});

describe('defaultPolicies', () => {
  it('has the three builtins with spec §10 rule text, in order', () => {
    const [a, b, c] = defaultPolicies();
    expect(a).toMatchObject({
      ord: 1,
      builtinKey: 'auto-read-staging-preview',
      ruleText: 'Auto-approve read on any staging or preview target',
    });
    expect(b).toMatchObject({
      ord: 2,
      builtinKey: 'ask-mfa-prod-write',
      ruleText: 'Always ask, require {mfa} for prod write',
    });
    expect(c).toMatchObject({
      ord: 3,
      builtinKey: 'idle-expiry-1h',
      ruleText: 'Expire grants after 1h idle',
    });
    expect(a?.id).toBe(BUILTIN_POLICY_IDS['auto-read-staging-preview']);
    expect(defaultPolicies(5).every((p) => p.createdAt === 5)).toBe(true);
  });
  it('substitutes the platform MFA name', () => {
    const [, ask] = defaultPolicies();
    expect(ask && policyRuleText(ask, 'darwin')).toBe('Always ask, require Touch ID for prod write');
    expect(ask && policyRuleText(ask, 'win32')).toBe('Always ask, require Windows Hello for prod write');
  });
});

describe('matchesTarget', () => {
  const cases: [TargetMatch, boolean][] = [
    [{}, true],
    [{ provider: ['supabase'] }, true],
    [{ provider: ['vercel'] }, false],
    [{ env: ['prod'] }, true],
    [{ env: ['staging'] }, false],
    [{ targetIds: [targetId] }, true],
    [{ targetIds: [idFrom<'TargetId'>('other') as TargetId] }, false],
    [{ provider: ['supabase'], env: ['prod'] }, true],
  ];
  it.each(cases)('%j → %s', (match, expected) => {
    expect(matchesTarget(match, target())).toBe(expected);
  });
});

describe('evaluate order', () => {
  it('default: ask, decided by user, 1h idle from builtin #3', () => {
    expect(evaluate(input())).toEqual({
      decision: 'ask',
      decidedBy: 'user',
      requireMfa: false,
      maxDuration: 'always',
      onceOnly: false,
      idleMs: DEFAULT_IDLE_MS,
      policyId: null,
      grantId: null,
    });
  });

  it('persistent grant covering the scope wins over everything, even prod write', () => {
    const r = evaluate(input({ scope: ['deploy'], persistentGrants: [alwaysGrant()], appRules: [] }));
    expect(r).toMatchObject({
      decision: 'auto',
      decidedBy: 'persistent-grant',
      requireMfa: false,
      maxDuration: 'always',
      grantId: 'g-always',
      idleMs: null,
    });
  });

  it('persistent grant that does not cover the scope, is not live, or is on another target is ignored', () => {
    expect(evaluate(input({ scope: ['write'], persistentGrants: [alwaysGrant()] })).decidedBy).toBe('user');
    expect(evaluate(input({ persistentGrants: [alwaysGrant({ state: 'revoked' })] })).decidedBy).toBe('user');
    expect(
      evaluate(input({ persistentGrants: [alwaysGrant({ duration: '1h', expiresAt: NOW + 1 })] })).decidedBy,
    ).toBe('user');
    expect(
      evaluate(
        input({ persistentGrants: [alwaysGrant({ targetId: idFrom<'TargetId'>('other') as TargetId })] }),
      ).decidedBy,
    ).toBe('user');
  });

  it('target policy always → auto (persistent) when MFA is not forced', () => {
    expect(
      evaluate(input({ target: target({ env: 'preview', policy: 'always' }), scope: ['deploy'] })),
    ).toMatchObject({
      decision: 'auto',
      decidedBy: 'target-policy',
      maxDuration: 'always',
      requireMfa: false,
    });
  });

  it('target policy always on prod write still asks with MFA (forced, not disableable)', () => {
    const r = evaluate(input({ target: target({ policy: 'always' }), scope: ['write'] }));
    expect(r).toMatchObject({
      decision: 'ask',
      decidedBy: 'user',
      requireMfa: true,
      policyId: BUILTIN_POLICY_IDS['ask-mfa-prod-write'],
    });
  });

  it('builtin #1 auto-approves read on staging/preview for 1h', () => {
    const r = evaluate(input({ target: target({ env: 'staging', provider: 'vercel' }) }));
    expect(r).toMatchObject({
      decision: 'auto',
      decidedBy: 'policy',
      maxDuration: '1h',
      policyId: BUILTIN_POLICY_IDS['auto-read-staging-preview'],
      requireMfa: false,
    });
  });

  it('builtin #1 does not cover write on staging → default ask', () => {
    expect(evaluate(input({ target: target({ env: 'staging' }), scope: ['read', 'write'] }))).toMatchObject({
      decision: 'ask',
      policyId: null,
    });
  });

  it('builtin #2 asks with MFA for prod write and is cited', () => {
    expect(evaluate(input({ scope: ['read', 'write'] }))).toMatchObject({
      decision: 'ask',
      requireMfa: true,
      policyId: BUILTIN_POLICY_IDS['ask-mfa-prod-write'],
    });
  });

  it('disabled rules are skipped', () => {
    const rules = defaultPolicies().map((p) => ({ ...p, enabled: false }));
    expect(evaluate(input({ target: target({ env: 'staging' }), appRules: rules }))).toMatchObject({
      decision: 'ask',
      policyId: null,
      idleMs: null,
    });
  });

  it('app rules run by ord before project rules', () => {
    const projectAuto = policy('p-auto', 1, {
      kind: 'auto-approve',
      match: { provider: ['supabase'] },
      scopes: ['read'],
      duration: 'session',
    });
    const appAsk = policy('a-ask', 9, {
      kind: 'ask',
      match: { provider: ['supabase'] },
      scopes: ['read'],
      requireMfa: false,
    });
    expect(evaluate(input({ appRules: [appAsk], projectRules: [projectAuto] }))).toMatchObject({
      decision: 'ask',
      policyId: 'a-ask',
    });
    expect(evaluate(input({ appRules: [], projectRules: [projectAuto] }))).toMatchObject({
      decision: 'auto',
      maxDuration: 'session',
      policyId: 'p-auto',
    });
  });

  it('ord sorts within a list', () => {
    const later = policy('later', 2, { kind: 'ask', match: {}, scopes: ['read'], requireMfa: false });
    const earlier = policy('earlier', 1, {
      kind: 'auto-approve',
      match: {},
      scopes: ['read'],
      duration: 'once',
    });
    expect(evaluate(input({ target: target({ env: 'staging' }), appRules: [later, earlier] })).policyId).toBe(
      'earlier',
    );
  });

  it('an auto-approve rule matching prod write is downgraded to ask + MFA and still cited', () => {
    const risky = policy('risky', 1, {
      kind: 'auto-approve',
      match: { env: ['prod'] },
      scopes: ['read', 'write'],
      duration: '1h',
    });
    expect(evaluate(input({ scope: ['write'], appRules: [risky] }))).toMatchObject({
      decision: 'ask',
      requireMfa: true,
      policyId: 'risky',
    });
  });

  it('an auto-approve rule on an ask-mfa target asks with MFA', () => {
    const auto = policy('auto', 1, { kind: 'auto-approve', match: {}, scopes: ['read'], duration: '1h' });
    expect(evaluate(input({ target: target({ policy: 'ask-mfa' }), appRules: [auto] }))).toMatchObject({
      decision: 'ask',
      requireMfa: true,
      policyId: 'auto',
    });
  });

  it('ask-mfa target policy forces MFA even on read', () => {
    expect(evaluate(input({ target: target({ policy: 'ask-mfa' }), appRules: [] })).requireMfa).toBe(true);
  });

  it('ask rule with requireMfa on a non-prod target requires MFA', () => {
    const rule = policy('mfa-read', 1, { kind: 'ask', match: {}, scopes: ['read'], requireMfa: true });
    expect(evaluate(input({ target: target({ env: 'staging' }), appRules: [rule] }))).toMatchObject({
      decision: 'ask',
      requireMfa: true,
    });
  });

  it('idle-expiry rule: first matching wins, matching by target', () => {
    const short = policy('short', 1, {
      kind: 'idle-expiry',
      match: { provider: ['vercel'] },
      idleMs: 60_000,
    });
    const long = policy('long', 2, { kind: 'idle-expiry', match: {}, idleMs: 120_000 });
    expect(evaluate(input({ appRules: [short, long] })).idleMs).toBe(120_000);
    expect(evaluate(input({ target: target({ provider: 'vercel' }), appRules: [short, long] })).idleMs).toBe(
      60_000,
    );
  });

  it('idle-expiry rules never decide', () => {
    const idle = policy('idle', 1, { kind: 'idle-expiry', match: {}, idleMs: 1 });
    expect(evaluate(input({ appRules: [idle] }))).toMatchObject({
      decision: 'ask',
      policyId: null,
      idleMs: 1,
    });
  });

  it('rules whose target match fails are skipped', () => {
    const other = policy('other', 1, {
      kind: 'auto-approve',
      match: { provider: ['aws'] },
      scopes: ['read'],
      duration: '1h',
    });
    expect(evaluate(input({ target: target({ env: 'staging' }), appRules: [other] })).policyId).toBeNull();
  });

  it('ask rule needs scope overlap', () => {
    const ask = policy('ask-deploy', 1, { kind: 'ask', match: {}, scopes: ['deploy'], requireMfa: true });
    expect(evaluate(input({ target: target({ env: 'staging' }), appRules: [ask] }))).toMatchObject({
      decision: 'ask',
      policyId: null,
      requireMfa: false,
    });
  });

  it('a session that may not request targets is denied', () => {
    expect(evaluate(input({ session: { id: 's1', mayRequestTargets: false } }))).toMatchObject({
      decision: 'deny',
      decidedBy: 'policy',
      maxDuration: 'once',
    });
  });

  it('no session (styx CLI outside a session) evaluates normally', () => {
    expect(evaluate(input({ session: null })).decision).toBe('ask');
  });
});

describe('once only: prod write on a credential not narrowed per grant (issue #29)', () => {
  const ENVS = ['prod', 'staging', 'preview', 'scm'] as const;
  const SCOPES: Scope[][] = [
    ['read'],
    ['write'],
    ['deploy'],
    ['delete'],
    ['read', 'write'],
    ['read', 'deploy'],
  ];
  const isWrite = (scope: readonly Scope[]) => scope.some((s) => s !== 'read');
  const rows = ENVS.flatMap((env) =>
    SCOPES.flatMap((scope) =>
      [true, false].map((credentialScoped) => ({
        env,
        scope,
        credentialScoped,
        once: env === 'prod' && isWrite(scope) && !credentialScoped,
      })),
    ),
  );

  it.each(rows)(
    '$env $scope scoped=$credentialScoped → once only $once',
    ({ env, scope, credentialScoped, once }) => {
      expect(onceOnly(env, scope, credentialScoped)).toBe(once);
      const max = maxGrantDuration(env, scope, credentialScoped);
      expect(max).toBe(once ? 'once' : 'always');
      // Every duration a person can pick, clamped to what the request allows.
      for (const want of DURATION_ORDER) expect(clampDuration(want, max)).toBe(once ? 'once' : want);
      expect(allowedDurations(max)).toEqual(once ? ['once'] : [...DURATION_ORDER]);
      // The default policies never auto-approve it, and the answer the sheet may give is capped.
      const d = evaluate(input({ target: target({ env }), scope, credentialScoped }));
      expect(d.onceOnly).toBe(once);
      if (once) expect(d).toMatchObject({ decision: 'ask', requireMfa: true, maxDuration: 'once' });
    },
  );

  it('MFA for approval: prod write, an ask-mfa target, or any prod scope on an unscoped credential', () => {
    const cases: [Target['env'], Target['policy'], Scope[], boolean, boolean][] = [
      ['prod', 'ask', ['write'], true, true],
      ['prod', 'ask', ['read'], true, false],
      ['prod', 'ask', ['read'], false, true],
      ['staging', 'ask', ['write'], false, false],
      ['staging', 'ask-mfa', ['read'], true, true],
      ['preview', 'always', ['deploy'], false, false],
    ];
    for (const [env, policy, scope, credentialScoped, expected] of cases)
      expect(approvalNeedsMfa({ env, policy }, scope, credentialScoped)).toBe(expected);
  });

  it('clampDuration keeps shorter picks and cuts longer ones; allowedDurations lists up to the cap', () => {
    expect(clampDuration('once', '1h')).toBe('once');
    expect(clampDuration('session', '1h')).toBe('1h');
    expect(allowedDurations('session')).toEqual(['once', '1h', 'session']);
  });

  const unscopedProd = (over: Partial<PolicyInput> = {}) =>
    input({ credentialScoped: false, scope: ['write'], ...over });

  it('a target policy `always` does not make a production write standing: it asks, once, with MFA', () => {
    expect(evaluate(unscopedProd({ target: target({ policy: 'always' }) }))).toMatchObject({
      decision: 'ask',
      decidedBy: 'user',
      requireMfa: true,
      maxDuration: 'once',
      onceOnly: true,
    });
  });

  it('an existing `always` grant covering the scope does not carry it', () => {
    const g = alwaysGrant({ scope: ['read', 'write'] });
    expect(evaluate(unscopedProd({ persistentGrants: [g] }))).toMatchObject({
      decision: 'ask',
      grantId: null,
      maxDuration: 'once',
    });
    // Control: the same grant still covers on a target whose credential is narrowed.
    expect(evaluate(input({ scope: ['write'], persistentGrants: [g] }))).toMatchObject({
      decision: 'auto',
      grantId: 'g-always',
    });
  });

  it('auto-approve and ask rules both end in an ask capped at once', () => {
    const auto = policy('auto', 1, {
      kind: 'auto-approve',
      match: {},
      scopes: ['write'],
      duration: 'session',
    });
    const ask = policy('ask', 1, { kind: 'ask', match: {}, scopes: ['write'], requireMfa: false });
    expect(evaluate(unscopedProd({ appRules: [auto] }))).toMatchObject({
      decision: 'ask',
      requireMfa: true,
      maxDuration: 'once',
      policyId: 'auto',
    });
    expect(evaluate(unscopedProd({ appRules: [ask] }))).toMatchObject({
      decision: 'ask',
      requireMfa: true,
      maxDuration: 'once',
      policyId: 'ask',
    });
    expect(evaluate(unscopedProd({ appRules: [] }))).toMatchObject({ decision: 'ask', maxDuration: 'once' });
  });

  it('a production read on an unscoped credential is not capped but still needs MFA and is never auto-approved', () => {
    const auto = policy('auto', 1, { kind: 'auto-approve', match: {}, scopes: ['read'], duration: '1h' });
    expect(evaluate(unscopedProd({ scope: ['read'], appRules: [auto] }))).toMatchObject({
      decision: 'ask',
      requireMfa: true,
      maxDuration: 'always',
      onceOnly: false,
    });
    expect(evaluate(unscopedProd({ scope: ['read'], target: target({ policy: 'always' }) }))).toMatchObject({
      decision: 'ask',
      requireMfa: true,
      onceOnly: false,
    });
    // An existing `always` read grant still covers a read.
    expect(
      evaluate(unscopedProd({ scope: ['read'], persistentGrants: [alwaysGrant({ scope: ['read'] })] })),
    ).toMatchObject({ decision: 'auto', grantId: 'g-always' });
  });

  it('non-production writes on an unscoped credential keep the longer durations and auto policies', () => {
    expect(
      evaluate(unscopedProd({ target: target({ env: 'preview', policy: 'always' }), scope: ['deploy'] })),
    ).toMatchObject({ decision: 'auto', maxDuration: 'always', onceOnly: false, requireMfa: false });
  });
});

describe('evaluatePolicies alias', () => {
  it('is the same function as evaluate', () => {
    expect(evaluatePolicies).toBe(evaluate);
  });
});

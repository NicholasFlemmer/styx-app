import { idFrom } from '../ids';
import type { PolicyId } from '../ids';
import type { BuiltinPolicyKey, Policy } from '../model/policy';
import { platformCopy, copy, type CopyPlatform } from '../copy';

/** Stable ids so builtins can be referenced from fixtures and project files (`disabledBuiltins`). */
export const BUILTIN_POLICY_IDS: Record<BuiltinPolicyKey, PolicyId> = {
  'auto-read-staging-preview': idFrom<'PolicyId'>('01JSTYXBUILTINPOLICY000001'),
  'ask-mfa-prod-write': idFrom<'PolicyId'>('01JSTYXBUILTINPOLICY000002'),
  'idle-expiry-1h': idFrom<'PolicyId'>('01JSTYXBUILTINPOLICY000003'),
};

/** The three builtins (plan §5 PolicyEngine row), rule text verbatim from spec §10. */
export const defaultPolicies = (createdAt = 0): Policy[] => [
  {
    id: BUILTIN_POLICY_IDS['auto-read-staging-preview'],
    ord: 1,
    rule: { kind: 'auto-approve', match: { env: ['staging', 'preview'] }, scopes: ['read'], duration: '1h' },
    ruleText: copy.policies.autoApproveStagingRead,
    enabled: true,
    builtinKey: 'auto-read-staging-preview',
    matchCountToday: 0,
    matchCountWeek: 0,
    countersResetAt: null,
    createdAt,
  },
  {
    id: BUILTIN_POLICY_IDS['ask-mfa-prod-write'],
    ord: 2,
    rule: { kind: 'ask', match: { env: ['prod'] }, scopes: ['write', 'deploy', 'delete'], requireMfa: true },
    ruleText: copy.policies.askMfaProdWrite,
    enabled: true,
    builtinKey: 'ask-mfa-prod-write',
    matchCountToday: 0,
    matchCountWeek: 0,
    countersResetAt: null,
    createdAt,
  },
  {
    id: BUILTIN_POLICY_IDS['idle-expiry-1h'],
    ord: 3,
    rule: { kind: 'idle-expiry', match: {}, idleMs: 60 * 60 * 1000 },
    ruleText: copy.policies.idleExpiry,
    enabled: true,
    builtinKey: 'idle-expiry-1h',
    matchCountToday: 0,
    matchCountWeek: 0,
    countersResetAt: null,
    createdAt,
  },
];

/** Substitute `{mfa}` for the platform's biometric name ("Touch ID" / "Windows Hello"). */
export const policyRuleText = (policy: Pick<Policy, 'ruleText'>, platform: CopyPlatform): string =>
  policy.ruleText.replaceAll('{mfa}', platformCopy(platform).mfa);

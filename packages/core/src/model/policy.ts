import { z } from 'zod';
import {
  durationSchema,
  envSchema,
  policyIdSchema,
  providerSchema,
  scopeSchema,
  targetIdSchema,
  timestampSchema,
} from './common';

/** All listed fields must match (AND); an omitted field matches anything. */
export const targetMatchSchema = z.object({
  provider: z.array(providerSchema).optional(),
  env: z.array(envSchema).optional(),
  targetIds: z.array(targetIdSchema).optional(),
});
export type TargetMatch = z.infer<typeof targetMatchSchema>;

export const policyRuleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('auto-approve'),
    match: targetMatchSchema,
    scopes: z.array(scopeSchema).min(1),
    duration: durationSchema,
  }),
  z.object({
    kind: z.literal('ask'),
    match: targetMatchSchema,
    scopes: z.array(scopeSchema).min(1),
    requireMfa: z.boolean(),
  }),
  z.object({
    kind: z.literal('idle-expiry'),
    match: targetMatchSchema,
    idleMs: z.number().int().positive(),
  }),
]);
export type PolicyRule = z.infer<typeof policyRuleSchema>;
export type PolicyRuleKind = PolicyRule['kind'];

export const builtinPolicyKeySchema = z.enum([
  'auto-read-staging-preview',
  'ask-mfa-prod-write',
  'idle-expiry-1h',
]);
export type BuiltinPolicyKey = z.infer<typeof builtinPolicyKeySchema>;

export const policySchema = z.object({
  id: policyIdSchema,
  /** 1-based evaluation order; rendered as "policy #n". */
  ord: z.number().int().positive(),
  rule: policyRuleSchema,
  /** Human rule text; may contain `{mfa}` which is substituted per platform. */
  ruleText: z.string().min(1),
  enabled: z.boolean(),
  builtinKey: builtinPolicyKeySchema.nullable(),
  matchCountToday: z.number().int().nonnegative(),
  matchCountWeek: z.number().int().nonnegative(),
  countersResetAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
});
export type Policy = z.infer<typeof policySchema>;

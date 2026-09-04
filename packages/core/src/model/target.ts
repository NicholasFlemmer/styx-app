import { z } from 'zod';
import {
  authMethodSchema,
  envSchema,
  jsonObjectSchema,
  projectIdSchema,
  providerSchema,
  targetIdSchema,
  targetPolicySchema,
  timestampSchema,
} from './common';

export const targetHealthSchema = z.enum(['ok', 'expired', 'unconnected']);
export type TargetHealth = z.infer<typeof targetHealthSchema>;

export const policySourceSchema = z.enum(['app', 'project']);
export type PolicySource = z.infer<typeof policySourceSchema>;

export const targetSchema = z.object({
  id: targetIdSchema,
  projectId: projectIdSchema,
  provider: providerSchema,
  /** Display name, e.g. "Vercel", "AWS acme-prod", "GitHub acme/shop". */
  name: z.string().min(1),
  env: envSchema,
  authMethod: authMethodSchema,
  policy: targetPolicySchema,
  policySource: policySourceSchema,
  /** Keychain reference; the secret itself never leaves the OS keychain. */
  credentialRef: z.string().nullable(),
  health: targetHealthSchema,
  healthCheckedAt: timestampSchema.nullable(),
  expiredAt: timestampSchema.nullable(),
  config: jsonObjectSchema,
  fromProjectFile: z.boolean(),
  createdAt: timestampSchema,
});
export type Target = z.infer<typeof targetSchema>;

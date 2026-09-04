import { z } from 'zod';
import {
  durationSchema,
  grantIdSchema,
  policyIdSchema,
  scopeSchema,
  sessionIdSchema,
  targetIdSchema,
  timestampSchema,
  worktreeIdSchema,
} from './common';

export const grantStateSchema = z.enum(['requested', 'active', 'denied', 'revoked', 'expired']);
export type GrantState = z.infer<typeof grantStateSchema>;

export const revokeReasonSchema = z.enum([
  'user',
  'expired',
  'idle',
  'session-end',
  'once-used',
  'target-removed',
  'policy',
]);
export type RevokeReason = z.infer<typeof revokeReasonSchema>;

export const decidedBySchema = z.enum(['user', 'policy', 'target-policy', 'persistent-grant']);
export type DecidedBy = z.infer<typeof decidedBySchema>;

export const grantSchema = z.object({
  id: grantIdSchema,
  /** Null once an `always` grant has been issued (it outlives the session). */
  sessionId: sessionIdSchema.nullable(),
  targetId: targetIdSchema,
  worktreeId: worktreeIdSchema.nullable(),
  scope: z.array(scopeSchema).min(1),
  duration: durationSchema,
  /** The agent's verbatim reason. */
  reason: z.string(),
  state: grantStateSchema,
  requestedAt: timestampSchema,
  issuedAt: timestampSchema.nullable(),
  expiresAt: timestampSchema.nullable(),
  lastUsedAt: timestampSchema.nullable(),
  idleExpiresAt: timestampSchema.nullable(),
  revokedAt: timestampSchema.nullable(),
  revokeReason: revokeReasonSchema.nullable(),
  policyId: policyIdSchema.nullable(),
  mfaVerified: z.boolean(),
  decidedBy: decidedBySchema.nullable(),
});
export type Grant = z.infer<typeof grantSchema>;

export const grantUseViaSchema = z.enum(['shim', 'get_credential', 'ssh-agent-sign', 'styx-cli']);
export type GrantUseVia = z.infer<typeof grantUseViaSchema>;

export const grantUseSchema = z.object({
  id: z.string().min(1),
  grantId: grantIdSchema,
  sessionId: sessionIdSchema.nullable(),
  via: grantUseViaSchema,
  /** The triggering command, rendered as "Triggered by" in the audit drawer. */
  command: z.string().nullable(),
  scopeUsed: scopeSchema,
  exitCode: z.number().int().nullable(),
  startedAt: timestampSchema,
  endedAt: timestampSchema.nullable(),
});
export type GrantUse = z.infer<typeof grantUseSchema>;

import { z } from 'zod';
import {
  agentSchema,
  auditIdSchema,
  durationSchema,
  grantIdSchema,
  jsonObjectSchema,
  policyIdSchema,
  projectIdSchema,
  scopeSchema,
  sessionIdSchema,
  targetIdSchema,
  timestampSchema,
  worktreeIdSchema,
} from './common';

export const auditActorKindSchema = z.enum(['you', 'system', 'agent']);
export type AuditActorKind = z.infer<typeof auditActorKindSchema>;

export const auditActionSchema = z.enum([
  'requested',
  'granted',
  'denied',
  'used',
  'revoked',
  'expired',
  'opened-pr',
  'merged-pr',
  'connected',
  'disconnected',
  'tested',
  'policy-changed',
  'exported',
]);
export type AuditAction = z.infer<typeof auditActionSchema>;

/**
 * Append-only, hash-chained. Ids in this row are not foreign keys: the audit outlives the rows it
 * points at, so the labels are denormalised at write time.
 */
export const auditEntrySchema = z.object({
  id: auditIdSchema,
  seq: z.number().int().nonnegative(),
  time: timestampSchema,
  actorKind: auditActorKindSchema,
  /** "you" | "system" | agent product name ("Claude"). */
  actorLabel: z.string().min(1),
  action: auditActionSchema,
  projectId: projectIdSchema.nullable(),
  targetId: targetIdSchema.nullable(),
  sessionId: sessionIdSchema.nullable(),
  worktreeId: worktreeIdSchema.nullable(),
  grantId: grantIdSchema.nullable(),
  policyId: policyIdSchema.nullable(),
  /** Slug label, e.g. "vercel-prod", "aws-acme-prod", "github". */
  targetLabel: z.string().nullable(),
  sessionLabel: z.string().nullable(),
  worktreeLabel: z.string().nullable(),
  agent: agentSchema.nullable(),
  scope: z.array(scopeSchema).nullable(),
  duration: durationSchema.nullable(),
  /** "grant sheet" | "idle timer" | "$ vercel deploy --prod" | "mcp:request_access". */
  triggeredBy: z.string().nullable(),
  detail: jsonObjectSchema,
  prevHash: z.string().nullable(),
  hash: z.string(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

/** The fields a producer supplies; seq/hash chain are computed by AuditService. */
export const auditDraftSchema = auditEntrySchema.omit({ id: true, seq: true, prevHash: true, hash: true });
export type AuditDraft = z.infer<typeof auditDraftSchema>;

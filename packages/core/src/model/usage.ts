import { z } from 'zod';
import { agentSchema, timestampSchema } from './common';

/** One rate-limit window a provider reports ("5 h", "7 d"): how much of it is used and when it resets. */
export const rateLimitWindowSchema = z.object({
  label: z.string().min(1),
  usedPercent: z.number().min(0).max(100),
  resetsAt: timestampSchema.nullable(),
});
export type RateLimitWindow = z.infer<typeof rateLimitWindowSchema>;

/** The latest limits a CLI reported for its account (Codex `account/rateLimits`, Claude `rate_limit_event`). */
export const agentLimitsSchema = z.object({
  agent: agentSchema,
  /** Plan or account label when the CLI reports one ("team", "pro"). */
  plan: z.string().nullable(),
  windows: z.array(rateLimitWindowSchema),
  updatedAt: timestampSchema,
});
export type AgentLimits = z.infer<typeof agentLimitsSchema>;

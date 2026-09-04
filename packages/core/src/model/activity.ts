import { z } from 'zod';
import { projectIdSchema, sessionIdSchema, timestampSchema } from './common';

/** Home → Activity feed row (mono, newest first): `2m · Claude · acme-shop · edited checkout.ts …`. */
export const activityRowSchema = z.object({
  id: z.string().min(1),
  at: timestampSchema,
  /** "you" | "system" | agent product name ("Claude"). */
  who: z.string().min(1),
  what: z.string(),
  projectId: projectIdSchema.nullable(),
  sessionId: sessionIdSchema.nullable(),
});
export type ActivityRow = z.infer<typeof activityRowSchema>;

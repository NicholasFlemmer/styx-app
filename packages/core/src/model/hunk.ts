import { z } from 'zod';
import { hunkIdSchema, sessionIdSchema, timestampSchema, worktreeIdSchema } from './common';

export const diffLineKindSchema = z.enum(['context', 'add', 'remove']);
export type DiffLineKind = z.infer<typeof diffLineKindSchema>;

export const diffLineSchema = z.object({
  kind: diffLineKindSchema,
  text: z.string(),
  oldLine: z.number().int().positive().nullable(),
  newLine: z.number().int().positive().nullable(),
});
export type DiffLine = z.infer<typeof diffLineSchema>;

/** A parsed unified-diff hunk (pure data; what `diff/unified.ts` produces). */
export const hunkSchema = z.object({
  file: z.string().min(1),
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  /** "@@ -1,2 +1,3 @@" (without a trailing section heading). */
  header: z.string(),
  lines: z.array(diffLineSchema),
  /** Stable content hash (file + line content), independent of line numbers. */
  hunkHash: z.string().min(1),
  /** Minimal patch text that `git apply` accepts for this hunk alone. */
  patch: z.string(),
});
export type Hunk = z.infer<typeof hunkSchema>;

/**
 * Review status of an agent hunk. The agent already applied its edit, so the values read: `pending` = applied,
 * not yet looked at · `accepted` = marked reviewed (the DB/enum value is kept; nothing is staged or applied on
 * the way there) · `rejected` = reverted in the working tree · `stale` = no longer present in the worktree diff.
 */
export const changeStatusSchema = z.enum(['pending', 'accepted', 'rejected', 'stale']);
export type ChangeStatus = z.infer<typeof changeStatusSchema>;

/** A hunk attributed to an agent session, with review status. */
export const agentChangeSchema = z.object({
  id: hunkIdSchema,
  sessionId: sessionIdSchema,
  worktreeId: worktreeIdSchema,
  file: z.string().min(1),
  hunkHash: z.string().min(1),
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  patch: z.string(),
  status: changeStatusSchema,
  firstSeenAt: timestampSchema,
  lastSeenAt: timestampSchema,
  decidedAt: timestampSchema.nullable(),
});
export type AgentChange = z.infer<typeof agentChangeSchema>;

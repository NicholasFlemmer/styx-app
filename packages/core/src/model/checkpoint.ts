import { z } from 'zod';
import { sessionIdSchema, timestampSchema, worktreeIdSchema } from './common';

/**
 * A checkpoint is one agent turn's workspace state, kept as hidden git refs (`refs/styx/checkpoints/<session>/<n>`)
 * so nothing lands on the user's branch. `baseRef` is the tree before the turn, `ref` the tree after it (null while
 * the turn is still running). The diff between them is the turn's change; reverting a turn restores `baseRef`.
 */
export const checkpointSchema = z.object({
  id: z.string().min(1),
  sessionId: sessionIdSchema,
  worktreeId: worktreeIdSchema,
  /** 1-based turn number within the session. */
  turn: z.number().int().positive(),
  /** The user message that started the turn, when known. */
  messageId: z.string().nullable(),
  baseRef: z.string().min(1),
  ref: z.string().nullable(),
  /** Numstat of the turn's change once settled. */
  files: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  createdAt: timestampSchema,
  settledAt: timestampSchema.nullable(),
  /** Set when the user reverted this turn; the workspace was restored to `baseRef`. */
  revertedAt: timestampSchema.nullable(),
  /**
   * Which screenshots of the running app exist for this turn (the design window's page or the mirrored device,
   * captured at turn start and settle); served as `styx-device://checkpoint/<id>/<which>`.
   */
  screens: z.array(z.enum(['before', 'after'])).default([]),
});
export type Checkpoint = z.infer<typeof checkpointSchema>;

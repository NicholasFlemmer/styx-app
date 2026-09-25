import { z } from 'zod';
import { timestampSchema } from './common';

/**
 * Updates in place (owner request, discrepancy #119): the running app looks for a newer signed build, downloads it
 * in the background, and installs it when Styx next quits (or now, on "Restart to update"). `off` in development,
 * under the e2e harness, and in a build without an update feed.
 */
export const updateStatusSchema = z.enum(['off', 'idle', 'checking', 'downloading', 'ready', 'error']);
export type UpdateStatus = z.infer<typeof updateStatusSchema>;

export const updateStateSchema = z.object({
  /** The running version. */
  current: z.string(),
  status: updateStatusSchema,
  /** The version being downloaded, or downloaded and waiting to install. */
  next: z.string().nullable(),
  /** Download progress 0–100 while `downloading`. */
  percent: z.number().min(0).max(100).nullable(),
  /** When the feed last answered. */
  checkedAt: timestampSchema.nullable(),
  /** Why the last check or download failed, in plain words; null otherwise. */
  error: z.string().nullable(),
});
export type UpdateState = z.infer<typeof updateStateSchema>;

export const UPDATE_OFF: UpdateState = {
  current: '',
  status: 'off',
  next: null,
  percent: null,
  checkedAt: null,
  error: null,
};

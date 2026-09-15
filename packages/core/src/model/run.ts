import { z } from 'zod';
import { projectIdSchema, targetIdSchema, timestampSchema } from './common';

/** Phase of a local dev-server run started from the design window. */
export const devRunPhaseSchema = z.enum(['starting', 'running', 'exited']);
export type DevRunPhase = z.infer<typeof devRunPhaseSchema>;

/**
 * One "Run locally" process per project (owner addition: the design window used to need the URL typed in).
 * Main owns the pty; the renderer attaches a terminal by `terminalId`. `url` is the first localhost URL seen in
 * the output, which also fills the project's `devUrl` when it was empty.
 */
export const devRunSchema = z.object({
  projectId: projectIdSchema,
  runId: z.string().min(1),
  terminalId: z.string().min(1),
  command: z.string().min(1),
  phase: devRunPhaseSchema,
  url: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  startedAt: timestampSchema,
  endedAt: timestampSchema.nullable(),
});
export type DevRun = z.infer<typeof devRunSchema>;

export const deployPhaseSchema = z.enum(['requesting-grant', 'running', 'succeeded', 'failed', 'cancelled']);
export type DeployPhase = z.infer<typeof deployPhaseSchema>;

/**
 * A deploy Styx is running (or just ran) for a target. Lives in the read model so progress survives closing the
 * modal: the status bar, the deploy button and a finish toast all read the same row.
 */
export const deploySchema = z.object({
  deployId: z.string().min(1),
  targetId: targetIdSchema,
  projectId: projectIdSchema,
  phase: deployPhaseSchema,
  terminalId: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  error: z.string().nullable(),
  startedAt: timestampSchema,
  endedAt: timestampSchema.nullable(),
});
export type Deploy = z.infer<typeof deploySchema>;

export const isDeployActive = (d: Pick<Deploy, 'phase'>): boolean =>
  d.phase === 'requesting-grant' || d.phase === 'running';

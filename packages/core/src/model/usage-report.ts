import { z } from 'zod';

/**
 * Usage reporting (owner request, discrepancy #114): how many people use Styx and which parts they reach.
 *
 * The shape of this file is the privacy promise. There is a **closed set of event names and nothing else** — no
 * properties, no free-form strings, no ids of anything but the account. A project name, a path, a branch, a
 * repo, a prompt or an agent's output cannot be sent because there is nowhere to put them. That is deliberate:
 * a leak has to be impossible by construction, not merely avoided by care.
 *
 * Events are only sent while signed in (they are counts per account) and only while the person leaves the
 * setting on.
 */

export const usageEventSchema = z.enum([
  /** A window opened. This is the heartbeat: daily / weekly / monthly actives and retention come from it. */
  'app.launched',
  /** A project was added, by any of the four routes. */
  'project.added',
  /** An agent session was spawned. */
  'agent.spawned',
  /** A grant request was approved. */
  'grant.approved',
  /** A deploy was started. */
  'deploy.run',
]);
export type UsageEvent = z.infer<typeof usageEventSchema>;
export const USAGE_EVENTS: readonly UsageEvent[] = usageEventSchema.options;

/**
 * One name, when it happened, and how many times — the whole vocabulary. `count` exists so a burst collapses
 * into one row rather than a hundred.
 */
export const usageReportRowSchema = z.object({
  name: usageEventSchema,
  /** Epoch ms of the first occurrence in this row. */
  at: z.number(),
  count: z.number().int().min(1).max(10_000),
});
export type UsageReportRow = z.infer<typeof usageReportRowSchema>;

/** A batch is small by design: the client flushes often and drops rather than hoarding. */
export const USAGE_BATCH_MAX = 100;

export const usageBatchSchema = z.object({
  events: z.array(usageReportRowSchema).max(USAGE_BATCH_MAX),
});
export type UsageBatch = z.infer<typeof usageBatchSchema>;

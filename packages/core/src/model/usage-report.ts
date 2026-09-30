import { z } from 'zod';

/**
 * Usage reporting (owner request, discrepancy #114): how many people use Styx and which parts they reach.
 *
 * The shape of this file is the privacy promise. There is a **closed set of event names and nothing else** — no
 * properties, no free-form strings, no ids of anything but a random install id and, when signed in, the account.
 * A project name, a path, a branch, a repo, a prompt or an agent's output cannot be sent because there is
 * nowhere to put them. That is deliberate: a leak has to be impossible by construction, not merely avoided by
 * care.
 *
 * Events are sent signed in or not (discrepancy #122: counts belong to a random install id, and to the account
 * as well while there is one), and only while the person leaves the setting on.
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
  /** Onboarding was finished: how many installs get from download to set up. */
  'onboarding.completed',
  /** A message was sent to an agent: the day-to-day use, rather than the setting up. */
  'message.sent',
  /** A lane was landed on main: agent work that actually shipped. */
  'lane.landed',
  // --- Where new people get stuck (owner request, #125): still names only, one per reason. ---
  /** The first-run walkthrough came on screen / was played to the end / was closed early. */
  'tour.shown',
  'tour.finished',
  'tour.skipped',
  /** An agent could not start or stopped at once, by reason: its CLI is not installed; the process would not
   * launch; the CLI says it is not signed in; the CLI is too old; the CLI reported another error; the CLI
   * exited with an error within its first seconds, before finishing a turn. */
  'agent.failed.cli-missing',
  'agent.failed.launch',
  'agent.failed.sign-in',
  'agent.failed.outdated',
  'agent.failed.error',
  'agent.failed.exited',
  /** A window's page crashed; one of the app's helper processes (graphics, network) crashed; the previous run
   * ended without quitting (a crash, a force quit, or the Mac losing power), noticed at the next launch. */
  'app.crashed.window',
  'app.crashed.helper',
  'app.ended-unexpectedly',
  /** An agent finished its first piece of work in a session (#127), however it was asked: the composer, the
   * spawn dialog's first message, or typing straight into the agent's terminal. Once per session. */
  'agent.worked',
]);
export type UsageEvent = z.infer<typeof usageEventSchema>;
export const USAGE_EVENTS: readonly UsageEvent[] = usageEventSchema.options;

/** The events the renderer may note itself (the walkthrough lives there); everything else is recorded by main. */
export const RENDERER_USAGE_EVENTS = [
  'tour.shown',
  'tour.finished',
  'tour.skipped',
] as const satisfies readonly UsageEvent[];
export type AgentProblem = 'cli-missing' | 'launch' | 'sign-in' | 'outdated' | 'error' | 'exited';

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

/**
 * `inst_` and 22 url-safe characters from 16 random bytes, made once on first run. Random rather than derived
 * from the machine, so it points at nothing but itself, and a fresh one is a fresh start.
 */
export const installIdSchema = z.string().regex(/^inst_[A-Za-z0-9_-]{16,64}$/);

export const usageBatchSchema = z.object({
  installId: installIdSchema,
  /** The app's version, e.g. `0.2.6`: which releases are out there. */
  version: z.string().max(24),
  /** `process.platform`: `darwin` / `win32` / `linux`. */
  os: z.string().max(12),
  events: z.array(usageReportRowSchema).max(USAGE_BATCH_MAX),
});
export type UsageBatch = z.infer<typeof usageBatchSchema>;

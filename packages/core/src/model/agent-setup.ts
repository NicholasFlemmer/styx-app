import { z } from 'zod';
import { timestampSchema } from './common';

/**
 * Getting a coding agent running with as little friction as possible (owner request, design/next/
 * styx-next-agent-setup.html): one button per plan runs prepare → install → sign in → test, out of sight, and the
 * card says where it stands in plain words. Main owns this state (AgentSetupService) and re-sends an agent's
 * whole row on every change, like `update`.
 */
export const setupAgentSchema = z.enum(['claude', 'codex', 'gemini', 'cursor']);
export type SetupAgent = z.infer<typeof setupAgentSchema>;
export const SETUP_AGENTS: readonly SetupAgent[] = setupAgentSchema.options;

/**
 * `prepare`: what the agent needs first (Node.js for Gemini, a private copy Styx downloads; git on Windows, for
 * Claude's Bash tool). `install`: the vendor's installer. `signin`: the CLI's own browser sign-in. `test`: one tiny
 * message, so "Ready" means the plan really answers.
 */
export const setupStepSchema = z.enum(['prepare', 'install', 'signin', 'test']);
export type SetupStep = z.infer<typeof setupStepSchema>;
export const SETUP_STEPS: readonly SetupStep[] = setupStepSchema.options;

/**
 * What stopped a run, each with one fix on the card. `needs-plan`: signed in, but the account has no access (Claude
 * on the free plan). `limit`: the plan answered that it is out of usage for now. `out-of-date`: the CLI is too old to
 * sign in or answer from here (an update fixes it). `signin`: the browser sign-in did not finish.
 */
export const setupProblemSchema = z.enum([
  'prepare-failed',
  'install-failed',
  'signin',
  'needs-plan',
  'limit',
  'out-of-date',
  'test-failed',
]);
export type SetupProblem = z.infer<typeof setupProblemSchema>;

export const agentSetupSchema = z.object({
  agent: setupAgentSchema,
  /** `running` a step; `waiting` on the person (the browser sign-in); then `done`, `failed` or `cancelled`. */
  status: z.enum(['running', 'waiting', 'done', 'failed', 'cancelled']),
  step: setupStepSchema,
  /** What the prepare step is getting, in words ("Node.js"); null when there is nothing to prepare. */
  preparing: z.string().nullable(),
  /** The installed CLI's version and how long the install took; null until installed by this run. */
  installedVersion: z.string().nullable(),
  installMs: z.number().int().nonnegative().nullable(),
  /** How long the test message took to come back; null until tested. */
  testedMs: z.number().int().nonnegative().nullable(),
  /** The sign-in page the CLI pointed at, for "Didn't open? Copy the link"; null until it prints one. */
  url: z.string().nullable(),
  /** The CLI is asking for the code the browser shows (it could not reach the CLI's local callback). */
  wantsCode: z.boolean(),
  problem: setupProblemSchema.nullable(),
  /** One plain sentence about the problem; never CLI output. */
  message: z.string().nullable(),
  /** The hidden terminal behind the current step, for "Show details"; null when none is running. */
  terminalId: z.string().nullable(),
  startedAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type AgentSetup = z.infer<typeof agentSetupSchema>;

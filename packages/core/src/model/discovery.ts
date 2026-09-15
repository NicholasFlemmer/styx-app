import { z } from 'zod';
import { agentSchema, jsonObjectSchema, timestampSchema } from './common';

/** Editors Styx can detect and hand files to. `windsurf` is a VS Code fork (same config layout); `zed` has no recents import. */
export const ideKindSchema = z.enum(['vscode', 'cursor', 'windsurf', 'zed', 'jetbrains', 'neovim']);
export type IdeKind = z.infer<typeof ideKindSchema>;

export const ideInstallSchema = z.object({
  id: z.string().min(1),
  kind: ideKindSchema,
  /** "VS Code", "Cursor", "JetBrains (WebStorm)", "Neovim". */
  product: z.string().min(1),
  version: z.string().nullable(),
  location: z.string().nullable(),
  launcher: z.string().nullable(),
  configDir: z.string().nullable(),
  isFallback: z.boolean(),
  /** Where recent folders are read from; `shada` recents are only counted after an import. */
  recentsSource: z.enum(['state-db', 'recent-projects', 'shada']).nullable(),
  imported: z.object({
    recents: z.number().int().nonnegative(),
    keybindings: z.boolean(),
    theme: z.boolean(),
  }),
  detectedAt: timestampSchema,
});
export type IdeInstall = z.infer<typeof ideInstallSchema>;

export const cliAuthStateSchema = z.enum(['signed-in', 'signed-out', 'unknown', 'n/a']);
export type CliAuthState = z.infer<typeof cliAuthStateSchema>;

/** Where a CLI binary came from (`capabilities.source`); `manual` = picked with "Locate binary" (`detect.setBinary`). */
export const cliSourceSchema = z.enum([
  'path',
  'vscode-extension',
  'cursor-extension',
  'desktop-app',
  'manual',
]);
export type CliSource = z.infer<typeof cliSourceSchema>;

/** One runnable binary for an agent (`capabilities.alternatives`); the highest version wins unless overridden. */
export const cliCandidateSchema = z.object({
  binary: z.string().min(1),
  version: z.string().nullable(),
  source: cliSourceSchema,
});
export type CliCandidate = z.infer<typeof cliCandidateSchema>;

export const cliInstallSchema = z.object({
  agent: agentSchema,
  binary: z.string().nullable(),
  version: z.string().nullable(),
  found: z.boolean(),
  authState: cliAuthStateSchema,
  /** Flag capabilities (`streamJson` …) plus `source` and `alternatives` ride along here (no migration; see `cliSourceOf`). */
  capabilities: jsonObjectSchema,
  checkedAt: timestampSchema,
  /**
   * Connection (Settings › Agents): who the CLI says it is signed in as (`claude auth status`, `codex login status`,
   * `agent status`; Gemini's account file), when that was last checked, and the failure text if the check failed.
   * Never a token — the CLI keeps its own credentials.
   */
  account: z.string().nullable().default(null),
  verifiedAt: timestampSchema.nullable().default(null),
  verifyError: z.string().nullable().default(null),
});
export type CliInstall = z.infer<typeof cliInstallSchema>;

/** Where a skill lives: the user's own, this project's committed ones, or the remote catalogue. */
export const skillScopeSchema = z.enum(['global', 'project', 'catalogue']);
export type SkillScope = z.infer<typeof skillScopeSchema>;

/**
 * Which agent CLI reads the directory a skill sits in. Every CLI uses the same `SKILL.md` format but its own
 * roots (`.claude/skills`, `.codex/skills`, `.gemini/skills`, `.cursor/skills`); `agents` is the shared
 * `.agents/skills` convention Codex, Gemini CLI and Cursor all read. A catalogue row has no host yet.
 */
export const skillHostSchema = z.enum(['claude', 'codex', 'gemini', 'cursor', 'agents']);
export type SkillHost = z.infer<typeof skillHostSchema>;
export const SKILL_HOSTS: readonly SkillHost[] = skillHostSchema.options;
/** The hosts a skill can be installed for (the shared dir is listed, never written to). */
export const INSTALLABLE_SKILL_HOSTS: readonly Exclude<SkillHost, 'agents'>[] = ['claude', 'codex', 'gemini', 'cursor'];

/** One skill as listed in Settings or the catalogue. The body is fetched separately, to be read before install. */
export const skillSummarySchema = z.object({
  name: z.string(),
  /** The directory it lives in; the install/remove key, since `name` comes from user-authored frontmatter. */
  directory: z.string(),
  description: z.string(),
  scope: skillScopeSchema,
  /** Null for catalogue rows (not installed anywhere yet). */
  host: skillHostSchema.nullable(),
});
export type SkillSummary = z.infer<typeof skillSummarySchema>;

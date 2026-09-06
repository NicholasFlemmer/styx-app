import { z } from 'zod';
import { agentSchema, jsonObjectSchema, timestampSchema } from './common';

export const ideKindSchema = z.enum(['vscode', 'cursor', 'jetbrains', 'neovim']);
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
});
export type CliInstall = z.infer<typeof cliInstallSchema>;

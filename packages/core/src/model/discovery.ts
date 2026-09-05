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

export const cliInstallSchema = z.object({
  agent: agentSchema,
  binary: z.string().nullable(),
  version: z.string().nullable(),
  found: z.boolean(),
  authState: cliAuthStateSchema,
  capabilities: jsonObjectSchema,
  checkedAt: timestampSchema,
});
export type CliInstall = z.infer<typeof cliInstallSchema>;

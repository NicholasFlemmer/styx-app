import { z } from 'zod';
import { copy } from '../copy';
import type { Agent } from '../model/common';
import { modelInfoSchema, type ModelInfo } from '../model/session';
import type { ReadModel } from '../read-model';
import {
  cliCandidateSchema,
  cliSourceSchema,
  type CliCandidate,
  type CliInstall,
  type CliSource,
  type IdeInstall,
} from '../model/discovery';

/** Onboarding step 1 "version · location" cell: "1.98 · /Applications", "1.4", "not found". */
export const ideVersionLabel = (ide: Pick<IdeInstall, 'version' | 'location'>): string => {
  if (ide.version === null) return copy.onboarding.agents.notFound;
  return ide.location === null ? ide.version : `${ide.version} · ${ide.location}`;
};

/** Importable items: "14 recents · keybindings · theme", "3 recents", "recents via shada", "—". */
export const ideImportsLabel = (ide: Pick<IdeInstall, 'imported' | 'recentsSource'>): string => {
  const parts: string[] = [];
  if (ide.imported.recents > 0) parts.push(`${ide.imported.recents} recents`);
  else if (ide.recentsSource === 'shada') parts.push('recents via shada');
  if (ide.imported.keybindings) parts.push('keybindings');
  if (ide.imported.theme) parts.push('theme');
  return parts.length === 0 ? copy.general.none : parts.join(' · ');
};

/** Onboarding step 3 auth cell: "signed in" · "Sign in →" · "Install →" · "—". */
export const cliAuthLabel = (cli: Pick<CliInstall, 'found' | 'authState'>): string => {
  if (!cli.found) return copy.onboarding.agents.install;
  switch (cli.authState) {
    case 'signed-in':
      return copy.onboarding.agents.signedIn;
    case 'signed-out':
    case 'unknown':
      return copy.onboarding.agents.signIn;
    case 'n/a':
      return copy.general.none;
  }
};

/** Onboarding step 3 version cell: "claude 2.4.1", "not found on PATH". */
export const cliVersionLabel = (cli: Pick<CliInstall, 'agent' | 'found' | 'version' | 'binary'>): string => {
  if (!cli.found) return copy.onboarding.agents.notFound;
  // Windows paths split on `\` too, so "C:\Users\…\claude.exe" reads "claude", not the whole path.
  const base = cli.binary
    ?.split(/[\\/]/)
    .filter((seg) => seg.length > 0)
    .pop()
    ?.replace(/\.(exe|cmd|bat)$/i, '');
  const name = base === undefined ? cli.agent : base;
  return cli.version === null ? name : `${name} ${cli.version}`;
};

/** A binary the user picked with "Locate binary" (undo via `detect.clearBinary`). */
export const cliIsManual = (cli: Pick<CliInstall, 'capabilities'>): boolean => cliSourceOf(cli) === 'manual';

/** Each agent CLI's install guide (onboarding "Install →"); https only, so main's openExternal accepts them. */
export const CLI_INSTALL_URLS: Readonly<Record<Exclude<CliInstall['agent'], 'shell'>, string>> = {
  claude: 'https://code.claude.com/docs/en/setup',
  codex: 'https://developers.openai.com/codex/cli',
  gemini: 'https://github.com/google-gemini/gemini-cli#installation',
  cursor: 'https://cursor.com/docs/cli/installation',
  opencode: 'https://opencode.ai/docs',
};

/** `capabilities.source` of a detected CLI, or null for rows written before sources were recorded. */
export const cliSourceOf = (cli: Pick<CliInstall, 'capabilities'>): CliSource | null => {
  const r = cliSourceSchema.safeParse(cli.capabilities['source']);
  return r.success ? r.data : null;
};

/** The folders the last detection scanned for this agent (`capabilities.searched`): the not-installed row's "Show where". */
export const cliSearchedDirs = (cli: Pick<CliInstall, 'capabilities'>): string[] => {
  const r = z.array(z.string()).safeParse(cli.capabilities['searched']);
  return r.success ? r.data : [];
};

/** Every runnable binary detection found for the agent (`capabilities.alternatives`), the chosen one included. */
export const cliAlternatives = (cli: Pick<CliInstall, 'capabilities'>): CliCandidate[] => {
  const r = z.array(cliCandidateSchema).safeParse(cli.capabilities['alternatives']);
  return r.success ? r.data : [];
};

const binaryName = (binary: string | null, fallback: string): string => {
  const base = binary
    ?.split(/[\\/]/)
    .filter((seg) => seg.length > 0)
    .pop();
  return base === undefined ? fallback : base;
};

/** "claude 2.1.261 · VS Code extension" — one candidate as a Select option. */
export const cliCandidateLabel = (agent: string, c: CliCandidate): string =>
  `${binaryName(c.binary, agent)}${c.version === null ? '' : ` ${c.version}`} · ${copy.cliSources[c.source]}`;

/** Onboarding step 3 / Settings "Detected CLIs": `cliVersionLabel` plus the source ("claude 2.1.261 · VS Code extension"). */
export const cliLocationLabel = (
  cli: Pick<CliInstall, 'agent' | 'found' | 'version' | 'binary' | 'capabilities'>,
): string => {
  const base = cliVersionLabel(cli);
  if (!cli.found) return base;
  const source = cliSourceOf(cli);
  return source === null ? base : `${base} · ${copy.cliSources[source]}`;
};

/**
 * Settings › Agents state cell (owner addition): what one CLI's connection row says. `connected` needs a successful
 * `agent.verify` (`verifiedAt`); a detected sign-in that was never verified is `unverified`.
 */
export type CliConnectionState = 'connected' | 'unverified' | 'signed-out' | 'missing' | 'shell';

export const cliConnectionState = (
  cli: Pick<CliInstall, 'agent' | 'found' | 'authState' | 'verifiedAt'>,
): CliConnectionState => {
  if (cli.agent === 'shell') return 'shell';
  if (!cli.found) return 'missing';
  if (cli.authState !== 'signed-in') return 'signed-out';
  return cli.verifiedAt === null ? 'unverified' : 'connected';
};

/** Settings › Agents state cell text: `connected` · `not verified` · `signed out` · `not installed` · `ready`. */
export const cliConnectionLabel = (state: CliConnectionState): string => {
  const c = copy.agentsPage.state;
  switch (state) {
    case 'connected':
      return c.connected;
    case 'unverified':
      return c.unverified;
    case 'signed-out':
      return c.signedOut;
    case 'missing':
      return c.missing;
    case 'shell':
      return c.shell;
  }
};

/** Settings › Agents account cell: `nic@acme.dev`, `ChatGPT`, or `—` when the CLI has not said who it is. */
export const cliAccountLabel = (cli: Pick<CliInstall, 'account'>): string => cli.account ?? copy.general.none;

/** The models a CLI offers, as its last verification / session init stored them (`capabilities.models`); [] when unknown. */
export const modelCatalogueOf = (cli: Pick<CliInstall, 'capabilities'> | null | undefined): ModelInfo[] => {
  if (!cli) return [];
  const r = z.array(modelInfoSchema).safeParse(cli.capabilities['models']);
  return r.success ? r.data : [];
};

/** The catalogue of the CLI detected for `agent` ([] when undetected or the CLI does not publish one). */
export const modelCatalogueFor = (model: Pick<ReadModel, 'discovery'>, agent: Agent): ModelInfo[] =>
  modelCatalogueOf(model.discovery.clis.find((c) => c.agent === agent));

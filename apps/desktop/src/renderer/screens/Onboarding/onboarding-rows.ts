import { copy, type CliInstall, type CommandOutput, type IdeInstall } from '@styx/core';
import type { OnboardingStep } from '../../state/ui-store';

export const STEPS: readonly { n: OnboardingStep; label: string }[] = [
  { n: 1, label: copy.onboarding.steps.editor },
  { n: 2, label: copy.onboarding.steps.projects },
  { n: 3, label: copy.onboarding.steps.agents },
  { n: 4, label: copy.onboarding.steps.targets },
];

/** `1.98 · /Applications`; a missing version reads `not found`. */
export const ideVersionLabel = (ide: IdeInstall): string => {
  if (ide.version === null) return copy.onboarding.agents.notFound.replace(' on PATH', '');
  return ide.location === null ? ide.version : `${ide.version} · ${ide.location}`;
};

/** `14 recents · keybindings · theme`; nothing importable reads `—`. */
export const ideImportsLabel = (ide: IdeInstall): string => {
  const parts: string[] = [];
  if (ide.imported.recents > 0) parts.push(`${ide.imported.recents} recents`);
  if (ide.imported.keybindings) parts.push('keybindings');
  if (ide.imported.theme) parts.push('theme');
  return parts.length === 0 ? copy.general.none : parts.join(' · ');
};

export interface IdeImports {
  keybindings: boolean;
  theme: boolean;
  recents: boolean;
  installOpenIn: boolean;
}
export const DEFAULT_IDE_IMPORTS: IdeImports = {
  keybindings: true,
  theme: true,
  recents: true,
  installOpenIn: false,
};

/** `claude 2.4.1` / `zsh 5.9`; missing binaries read `not found on PATH`. */
export const cliVersionLabel = (cli: CliInstall): string => {
  if (!cli.found) return copy.onboarding.agents.notFound;
  const bin = cli.binary === null ? cli.agent : (cli.binary.split(/[\\/]/).pop() ?? cli.agent);
  return cli.version === null ? bin : `${bin} ${cli.version}`;
};

/** `signed in` · `Sign in →` · `Install →` · `—` (spec §4.9 Agents). */
export const cliAuthLabel = (cli: CliInstall): string => {
  if (!cli.found) return copy.onboarding.agents.install;
  switch (cli.authState) {
    case 'signed-in':
      return copy.onboarding.agents.signedIn;
    case 'signed-out':
      return copy.onboarding.agents.signIn;
    default:
      return copy.general.none;
  }
};

export type ScannedRepo = CommandOutput<'project.scan'>['repos'][number];

const YEAR = 365 * 24 * 60 * 60 * 1000;

const hostLabel = (remote: string): string => {
  const m = /^(?:https?:\/\/|git@|ssh:\/\/(?:[^@]+@)?)?([^/:]+)/.exec(remote);
  const host = (m?.[1] ?? remote).toLowerCase();
  return host.replace(/^www\./, '').replace(/\.(com|org|io|dev)$/, '');
};

/** `github · main` · `gitlab · main` · `no remote` · `no remote · 2y old`. */
export const repoMeta = (repo: ScannedRepo, now: number): string => {
  if (repo.remote === null) {
    const years = repo.lastModifiedAt === null ? 0 : Math.floor((now - repo.lastModifiedAt) / YEAR);
    return years >= 1 ? `no remote · ${years}y old` : 'no remote';
  }
  return repo.branch === null ? hostLabel(repo.remote) : `${hostLabel(repo.remote)} · ${repo.branch}`;
};

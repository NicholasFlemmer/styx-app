import { copy, type CommandOutput } from '@styx/core';
import type { OnboardingStep } from '../../state/ui-store';

export const STEPS: readonly { n: OnboardingStep; label: string }[] = [
  { n: 1, label: copy.onboarding.steps.editor },
  { n: 2, label: copy.onboarding.steps.projects },
  { n: 3, label: copy.onboarding.steps.agents },
  { n: 4, label: copy.onboarding.steps.targets },
];

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

export type ScannedRepo = CommandOutput<'project.scan'>['repos'][number];
/** A scan row, or a folder the user picked on step 2 (`picked`: not described by main, meta shows `—`). */
export type RepoRow = ScannedRepo & { picked?: boolean };

const YEAR = 365 * 24 * 60 * 60 * 1000;

const hostLabel = (remote: string): string => {
  const m = /^(?:https?:\/\/|git@|ssh:\/\/(?:[^@]+@)?)?([^/:]+)/.exec(remote);
  const host = (m?.[1] ?? remote).toLowerCase();
  return host.replace(/^www\./, '').replace(/\.(com|org|io|dev)$/, '');
};

/** `github · main` · `gitlab · main` · `no remote` · `no remote · 2y old` · `no git` (plain folder from IDE recents). */
export const repoMeta = (repo: ScannedRepo, now: number): string => {
  if (!repo.hasGit) return copy.workspace.noGit;
  if (repo.remote === null) {
    const years = repo.lastModifiedAt === null ? 0 : Math.floor((now - repo.lastModifiedAt) / YEAR);
    return years >= 1 ? `no remote · ${years}y old` : 'no remote';
  }
  return repo.branch === null ? hostLabel(repo.remote) : `${hostLabel(repo.remote)} · ${repo.branch}`;
};

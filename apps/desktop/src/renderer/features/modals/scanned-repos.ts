import { copy, type CommandOutput } from '@styx/core';

export type ScannedRepo = CommandOutput<'project.scan'>['repos'][number];
/** A scan row, or a folder the user picked (`picked`: not described by main, meta shows `—`). */
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

/** Row text for a scanned repo: `—` for a picked folder main has not described. */
export const rowMeta = (repo: RepoRow, now: number): string =>
  repo.picked === true ? copy.general.none : repoMeta(repo, now);

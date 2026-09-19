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

/**
 * Where a row came from, for the meta cell: `Claude Code` / `Codex` (the CLI's own session history, #93) or
 * `editor recents`; a repo the walker found on disk carries no source (the prototype's rows).
 */
export const sourceLabel = (source: ScannedRepo['source']): string | null => {
  switch (source) {
    case 'claude':
      return copy.agentProducts.claude;
    case 'codex':
      return copy.agentProducts.codex;
    case 'ide-recent':
      return copy.addExisting.sourceRecents;
    case 'scan':
      return null;
  }
};

/**
 * Row text for a scanned repo: the git meta, then the source when there is one (`github · main · Claude Code`,
 * `no git · Codex`); `—` for a picked folder main has not described.
 */
export const rowMeta = (repo: RepoRow, now: number): string => {
  if (repo.picked === true) return copy.general.none;
  const source = sourceLabel(repo.source);
  return source === null ? repoMeta(repo, now) : `${repoMeta(repo, now)} · ${source}`;
};

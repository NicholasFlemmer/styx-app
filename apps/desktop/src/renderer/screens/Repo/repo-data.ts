import {
  agentLabel,
  copy,
  diffTotals,
  fill,
  formatChanges,
  headAskOf,
  rows,
  type ProjectId,
  type ReadModel,
  type Repo,
  type SessionId,
  type UnifiedDiff,
  type Worktree,
  type WorktreeId,
} from '@styx/core';
import type { DotTone } from '@styx/ui';

const DAY = 24 * 60 * 60_000;

export type LaneAction = 'open' | 'diff' | 'resolve' | 'archive';

/** One Repo table row (prototype `lanes`). */
export interface Lane {
  worktreeId: WorktreeId;
  branch: string;
  owner: string;
  dot: DotTone;
  changes: string;
  pr: string;
  /** The PR's page, when known: the PR cell opens it in the browser. */
  prUrl: string | null;
  action: LaneAction;
  actionLabel: string;
  /**
   * Commit / push / PR in one step (ADR-0021): `Open PR` for a lane without an open PR, `Commit & push` for one
   * that has it (or main); none for merged or conflicted lanes, or a lane on no branch.
   */
  publishLabel: string | null;
  sessionId: SessionId | null;
  isMain: boolean;
  conflict: Worktree['conflict'];
}

const ACTION_LABEL: Record<LaneAction, string> = {
  open: copy.repo.actions.open,
  diff: copy.repo.actions.diff,
  resolve: copy.repo.actions.resolve,
  archive: copy.repo.actions.archive,
};

/** "yesterday" for the prototype's merged lane; "today" under a day, "{n}d ago" beyond. */
export const mergedWhen = (mergedAt: number, now: number): string => {
  const days = Math.floor(Math.max(0, now - mergedAt) / DAY);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
};

export const repoOfProject = (model: ReadModel, projectId: ProjectId): Repo | null =>
  rows(model.repos).find((r) => r.projectId === projectId) ?? null;

/** Header meta when the folder has no git: `no git`. */
export const noGitLine = (): string => copy.workspace.noGit;

/** "github.com/acme/shop" from a remote url (scheme, `.git`, and `git@` prefixes dropped). */
export const remoteLabel = (repo: Pick<Repo, 'remotes'> | null): string => {
  const url = repo?.remotes[0]?.url ?? null;
  if (url === null || url === '') return copy.general.none;
  return url
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^git@/, '')
    .replace(/^[^/@]+@/, '')
    .replace(':', '/')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
};

/** Header meta: `github.com/acme/shop · main ↑0 ↓2`. */
export const remoteLine = (repo: Repo | null): string =>
  fill(copy.repo.remoteLine, {
    remote: remoteLabel(repo),
    branch: repo?.defaultBranch ?? copy.general.none,
    ahead: repo?.ahead ?? 0,
    behind: repo?.behind ?? 0,
  });

const prLabel = (pr: Worktree['pr']): string =>
  pr === null ? copy.repo.pr.none : fill(copy.repo.pr[pr.state], { n: pr.number });

const hasOpenPr = (pr: Worktree['pr']): boolean =>
  pr !== null && (pr.state === 'open' || pr.state === 'draft');

/** Which publish verb a lane offers (see `Lane.publishLabel`). */
export const publishLabelOf = (
  w: Pick<Worktree, 'branch' | 'isMain' | 'pr' | 'conflict' | 'mergedAt'>,
): string | null => {
  if (w.branch === null || w.conflict !== null || w.mergedAt !== null) return null;
  return w.isMain || hasOpenPr(w.pr) ? copy.publish.button : copy.publish.buttonPr;
};

/** Lane order (prototype): main, then live worktrees in model order, merged ones last (they only await Archive). */
const laneRank = (w: Worktree): number => (w.isMain ? 0 : w.mergedAt === null ? 1 : 2);

/** Lanes of a project: non-archived worktrees, main first, merged last. */
export const laneRows = (model: ReadModel, projectId: ProjectId, now: number): Lane[] => {
  const repo = repoOfProject(model, projectId);
  const worktrees = rows(model.worktrees)
    .filter((w) => w.projectId === projectId && w.archivedAt === null)
    .sort((a, b) => laneRank(a) - laneRank(b));
  return worktrees.map((w): Lane => {
    const session = w.owner.kind === 'session' ? (model.sessions.byId[w.owner.sessionId] ?? null) : null;
    const owner = session === null ? copy.repo.you : agentLabel(session);
    const waiting = session !== null && headAskOf(model, session.id)?.kind === 'grant';
    const merged = w.mergedAt !== null;

    let changes: string;
    let action: LaneAction;
    if (w.conflict !== null) {
      changes = fill(copy.repo.changes.conflict, { file: w.conflict.file, against: w.conflict.against });
      action = 'resolve';
    } else if (merged) {
      changes = fill(copy.repo.changes.merged, { when: mergedWhen(w.mergedAt ?? now, now) });
      action = 'archive';
    } else if (waiting) {
      changes = copy.repo.changes.waitingOnGrant;
      action = 'diff';
    } else if (w.changes.files > 0) {
      changes = formatChanges(w.changes);
      action = w.isMain ? 'open' : 'diff';
    } else {
      changes = fill(copy.repo.changes.clean, {
        ahead: w.isMain ? (repo?.ahead ?? 0) : 0,
        behind: w.isMain ? (repo?.behind ?? 0) : 0,
      });
      action = w.isMain || session === null ? 'open' : 'diff';
    }

    const dot: DotTone =
      session?.state === 'needs-you' ? 'accent' : merged || session?.state === 'done' ? 'line' : 'text';

    return {
      worktreeId: w.id,
      branch: w.branch ?? copy.general.none,
      owner,
      dot,
      changes,
      pr: prLabel(w.pr),
      prUrl: w.pr?.url ?? null,
      action,
      actionLabel: ACTION_LABEL[action],
      publishLabel: publishLabelOf(w),
      sessionId: session?.id ?? null,
      isMain: w.isMain,
      conflict: w.conflict,
    };
  });
};

/** Selected lane: the active session's worktree, else the first agent lane with a diff, else main. */
export const defaultLane = (lanes: readonly Lane[], activeSessionId: SessionId | null): Lane | null => {
  if (lanes.length === 0) return null;
  const active = activeSessionId === null ? undefined : lanes.find((l) => l.sessionId === activeSessionId);
  return (
    active ??
    lanes.find((l) => !l.isMain && (l.action === 'diff' || l.action === 'resolve')) ??
    lanes[0] ??
    null
  );
};

/** `fix/checkout · checkout.ts · +2 −0` — branch, first file, and that file's line counts. */
export const laneDiffHeader = (branch: string, diff: UnifiedDiff): string => {
  const first = diff.files[0];
  if (first === undefined) return branch;
  const totals = diff.files.length === 1 ? { added: first.added, removed: first.removed } : diffTotals(diff);
  const file =
    diff.files.length === 1
      ? first.path
      : fill(copy.repo.changes.summary, {
          added: totals.added,
          removed: totals.removed,
          files: diff.files.length,
          filesWord: diff.files.length === 1 ? 'file' : 'files',
        });
  return diff.files.length === 1
    ? `${branch} · ${file} · +${totals.added} −${totals.removed}`
    : `${branch} · ${file}`;
};

/** Next free `wt-<n>` branch for `+ Worktree` (user worktrees have no agent prefix). */
export const nextWorktreeBranch = (model: ReadModel, projectId: ProjectId): string => {
  const taken = new Set(
    rows(model.worktrees)
      .filter((w) => w.projectId === projectId)
      .map((w) => w.branch),
  );
  let n = 1;
  while (taken.has(`wt-${n}`)) n += 1;
  return `wt-${n}`;
};

import type { ProjectId, SessionId } from '../ids';
import { headAsk } from '../machines/session';
import { AGENT_LABEL } from '../model/common';
import { repoHasGit, type Project, type Repo, type Worktree } from '../model/project';
import type { PendingAsk, Session } from '../model/session';
import type { ReadModel } from '../read-model';
import { rows } from '../read-model';

/** Sessions that have not been archived (Done keeps them 7 days). */
export const liveSessions = (model: ReadModel): Session[] =>
  rows(model.sessions).filter((s) => s.archivedAt === null);

export const sessionsInProject = (model: ReadModel, projectId: ProjectId): Session[] =>
  liveSessions(model).filter((s) => s.projectId === projectId && !s.purpose);

export const worktreeOf = (model: ReadModel, session: Pick<Session, 'worktreeId'>): Worktree | null =>
  model.worktrees.byId[session.worktreeId] ?? null;

export const projectOf = (model: ReadModel, projectId: ProjectId): Project | null =>
  model.projects.byId[projectId] ?? null;

export const branchOf = (model: ReadModel, session: Pick<Session, 'worktreeId'>): string =>
  worktreeOf(model, session)?.branch ?? '—';

export const repoOf = (model: ReadModel, projectId: ProjectId): Repo | null =>
  rows(model.repos).find((r) => r.projectId === projectId) ?? null;

/** False for a folder added as-is (no `.git`): agents work in it directly, no worktrees / diffs / reviews. */
export const projectHasGit = (model: ReadModel, projectId: ProjectId): boolean =>
  repoHasGit(repoOf(model, projectId));

export const mainWorktreeOf = (model: ReadModel, projectId: ProjectId): Worktree | null =>
  rows(model.worktrees).find((w) => w.projectId === projectId && w.isMain) ?? null;

export const projectNameOf = (model: ReadModel, projectId: ProjectId): string =>
  projectOf(model, projectId)?.name ?? '—';

export const agentLabel = (session: Pick<Session, 'agent'>): string => AGENT_LABEL[session.agent];

export const asksOf = (model: ReadModel, sessionId: SessionId): PendingAsk[] =>
  rows(model.pendingAsks).filter((a) => a.sessionId === sessionId);

/** The single surfaced ask for a session (queue head), or null. */
export const headAskOf = (model: ReadModel, sessionId: SessionId): PendingAsk | null =>
  headAsk(asksOf(model, sessionId));

/** Most recent first; sessions without activity last. */
export const byRecentActivity = (
  a: Pick<Session, 'lastActivityAt'>,
  b: Pick<Session, 'lastActivityAt'>,
): number => {
  if (a.lastActivityAt === b.lastActivityAt) return 0;
  if (a.lastActivityAt === null) return 1;
  if (b.lastActivityAt === null) return -1;
  return b.lastActivityAt - a.lastActivityAt;
};

/**
 * The branch a project is "on": the worktree of the chat tab the person is looking at (`activeSessionId`), else of
 * its default (first, non-done) session tab, else the main worktree.
 */
export const projectBranch = (
  model: ReadModel,
  projectId: ProjectId,
  activeSessionId: SessionId | null = null,
): string => projectBranchOrNull(model, projectId, activeSessionId) ?? '—';

/** Same, but null when the project is on no branch (plain folder, or no worktree yet); the project nav shows no branch line. */
export const projectBranchOrNull = (
  model: ReadModel,
  projectId: ProjectId,
  activeSessionId: SessionId | null = null,
): string | null => projectWorktreeOf(model, projectId, activeSessionId)?.branch ?? null;

/**
 * The worktree a project is "on" (what `projectBranch`, the editor column, Publish and Run locally read): the
 * active lane's worktree when one is given and it is a session of this project that is not archived (finished
 * lanes included, ADR-0027 §1), else the default (first, non-done) session's, else main. The workspace mirrors what the person is looking at (discrepancy #103), so
 * switching tabs switches files, terminal and status bar with it.
 */
export const projectWorktreeOf = (
  model: ReadModel,
  projectId: ProjectId,
  activeSessionId: SessionId | null = null,
): Worktree | null => {
  const all = sessionsInProject(model, projectId);
  const live = all.filter((s) => s.state !== 'done').sort((a, b) => a.startedAt - b.startedAt);
  // A finished lane picked from the nav (ADR-0027 §1) is still the one on screen.
  const active = activeSessionId === null ? undefined : all.find((s) => s.id === activeSessionId);
  const pick = active ?? live[0];
  if (pick !== undefined) return worktreeOf(model, pick) ?? null;
  return mainWorktreeOf(model, projectId);
};

/**
 * How many projects Styx keeps without an account (owner request, discrepancy #113). One is enough to try the
 * whole app; a second is where signing in starts to earn its keep.
 */
export const FREE_PROJECTS = 1;

/** Projects that still exist (a removed one does not count against the free allowance). */
export const liveProjectCount = (model: ReadModel): number =>
  rows(model.projects).filter((p) => p.removedAt === null).length;

/**
 * Whether adding another project asks for an account. Signed in, never. Signed out, only once the free one is
 * already there — so the app opens, the first project works, and nothing anyone already has is taken away.
 */
export const addingProjectNeedsAccount = (model: ReadModel): boolean =>
  model.account.kind !== 'signed-in' && liveProjectCount(model) >= FREE_PROJECTS;

/**
 * The lane on screen (ADR-0027 §1): the picked session when it is one of this project's that is not archived,
 * finished or not, else the first live one (the old default tab), else none.
 */
export const activeLaneOf = (
  model: ReadModel,
  projectId: ProjectId,
  sessionId: SessionId | null,
): SessionId | null => {
  const all = sessionsInProject(model, projectId);
  if (sessionId !== null && all.some((s) => s.id === sessionId)) return sessionId;
  return all.filter((s) => s.state !== 'done').sort((a, b) => a.startedAt - b.startedAt)[0]?.id ?? null;
};

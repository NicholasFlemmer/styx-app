import type { ProjectId, SessionId } from '../ids';
import { headAsk } from '../machines/session';
import { AGENT_LABEL } from '../model/common';
import type { Project, Worktree } from '../model/project';
import type { PendingAsk, Session } from '../model/session';
import type { ReadModel } from '../read-model';
import { rows } from '../read-model';

/** Sessions that have not been archived (Done keeps them 7 days). */
export const liveSessions = (model: ReadModel): Session[] =>
  rows(model.sessions).filter((s) => s.archivedAt === null);

export const sessionsInProject = (model: ReadModel, projectId: ProjectId): Session[] =>
  liveSessions(model).filter((s) => s.projectId === projectId);

export const worktreeOf = (model: ReadModel, session: Pick<Session, 'worktreeId'>): Worktree | null =>
  model.worktrees.byId[session.worktreeId] ?? null;

export const projectOf = (model: ReadModel, projectId: ProjectId): Project | null =>
  model.projects.byId[projectId] ?? null;

export const branchOf = (model: ReadModel, session: Pick<Session, 'worktreeId'>): string =>
  worktreeOf(model, session)?.branch ?? '—';

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

/** The branch a project is "on": the worktree of its default (first, non-done) session tab, else the main worktree. */
export const projectBranch = (model: ReadModel, projectId: ProjectId): string => {
  const first = sessionsInProject(model, projectId)
    .filter((s) => s.state !== 'done')
    .sort((a, b) => a.startedAt - b.startedAt)[0];
  if (first !== undefined) return branchOf(model, first);
  const main = rows(model.worktrees).find((w) => w.projectId === projectId && w.isMain);
  return main?.branch ?? '—';
};

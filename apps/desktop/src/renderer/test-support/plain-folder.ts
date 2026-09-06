import { fixtures, type ReadModel } from '@styx/core';

/**
 * The demo read model with `side-api` turned into a plain-folder project (owner decision: any folder is a project):
 * its repo row has `defaultBranch: null` / no remotes and its main worktree is on no branch. It has no sessions.
 */
export const plainFolderReadModel = (): ReadModel => {
  const f = fixtures.demoFixture();
  return fixtures.fixtureReadModel({
    ...f,
    repos: f.repos.map((r) =>
      r.id === fixtures.ids.repo.sideApi ? { ...r, defaultBranch: null, remotes: [] } : r,
    ),
    worktrees: f.worktrees.map((w) => (w.id === fixtures.ids.worktree.sideMain ? { ...w, branch: null } : w)),
  });
};

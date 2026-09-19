import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import { fail } from '../ipc/bus';
import type { Publisher } from '../store/publisher';
import type { GitService } from './git';

export interface WorktreeServiceDeps {
  repos: Repos;
  git: GitService;
  publisher: Publisher;
  clock: Clock;
  /** Ends a session that still lives on the lane (its CLI is killed; `finish` follows). */
  stopSession: (sessionId: string) => void;
  /** Stops watching the lane's files for hunks. */
  unwatch: (worktreeId: string) => Promise<void>;
}

/** Lane lifecycle shared by the `worktree.archive` command and the landing tidy-up (ADR-0025 phase C). */
export class WorktreeService {
  constructor(private readonly deps: WorktreeServiceDeps) {}

  /** Removes the lane's checkout (the branch stays), ends any session still on it, and marks the row archived. */
  async archive(worktreeId: string): Promise<void> {
    const { repos, git, publisher, clock } = this.deps;
    const wt = repos.worktrees.get(worktreeId) ?? fail('not-found', `worktree ${worktreeId} not found`);
    if (wt.isMain) fail('forbidden', 'the main worktree cannot be archived');
    if (wt.archivedAt !== null) return;
    const project = repos.projects.get(wt.projectId) ?? fail('not-found', 'project not found');
    for (const s of repos.sessions.byProject(project.id))
      if (s.worktreeId === wt.id && s.state !== 'done') this.deps.stopSession(s.id);
    await this.deps.unwatch(wt.id);
    await git.worktreeRemove(project.path, wt.path, true).catch(() => undefined);
    const current = repos.worktrees.get(wt.id) ?? wt;
    repos.worktrees.upsert({ ...current, archivedAt: clock.now() });
    publisher.upsert('worktrees', [wt.id]);
  }
}

import { copy } from '../copy';
import type { Target } from '../model/target';
import type { Session } from '../model/session';
import type { ReadModel } from '../read-model';
import { rows } from '../read-model';

export const taskKey = (
  s: Pick<Session, 'id' | 'purpose' | 'projectId' | 'taskTargetId' | 'worktreeId'>,
): string =>
  s.purpose === 'learn-run'
    ? `run:${s.projectId}`
    : s.purpose === 'debt-audit'
      ? `audit:${s.projectId}`
      : s.purpose === 'merge'
        ? `merge:${s.worktreeId}`
        : `deploy:${s.taskTargetId ?? s.id}`;

export const taskTitle = (purpose: Session['purpose'], target?: Pick<Target, 'name' | 'env'>): string =>
  purpose === 'learn-run'
    ? copy.tasks.run
    : purpose === 'learn-deploy'
      ? target
        ? `${copy.tasks.deploy} · ${target.name} ${target.env}`
        : copy.tasks.deploy
      : purpose === 'merge'
        ? copy.tasks.merge
        : copy.tasks.audit;

export const backgroundTasks = (model: ReadModel): Session[] =>
  rows(model.sessions)
    .reverse()
    .filter((s) => s.purpose && s.archivedAt === null)
    .sort((a, b) => b.startedAt - a.startedAt);

export const activeTask = (model: ReadModel, key: string): Session | null =>
  backgroundTasks(model).find((s) => taskKey(s) === key && s.state !== 'done') ?? null;

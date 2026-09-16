import {
  activeTask,
  copy,
  mainWorktreeOf,
  projectSettingsOfOrDefault,
  type ProjectId,
  type ReadModel,
  type SessionId,
  type SessionPurpose,
  type TargetId,
} from '@styx/core';
import { command } from '../../state/commands';
import { useUiStore } from '../../state/ui-store';

export interface TaskLaunch {
  key: string;
  projectId: ProjectId;
  purpose: SessionPurpose;
  sessionId: SessionId | null;
  error: string | null;
}

export const openTask = (key: string | null): void => {
  useUiStore.getState().pushOverlay({ kind: 'task', taskKey: key });
};

const pending = new Map<string, Promise<SessionId | null>>();

/** Open feedback before detection/spawn; neither completion nor dismissal changes the current project. */
export function launchTask(
  model: ReadModel,
  projectId: ProjectId,
  key: string,
  purpose: SessionPurpose,
  prompt: () => Promise<string>,
  targetId?: TargetId,
): Promise<SessionId | null> {
  openTask(key);
  const existing = activeTask(model, key);
  if (existing) {
    useUiStore.getState().setTaskLaunch(key, { key, projectId, purpose, sessionId: existing.id, error: null });
    return Promise.resolve(existing.id);
  }
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const launch: TaskLaunch = { key, projectId, purpose, sessionId: null, error: null };
  const ui = useUiStore.getState();
  ui.setTaskLaunch(key, launch);
  const run = async (): Promise<SessionId | null> => {
    try {
      const worktree = mainWorktreeOf(model, projectId);
      if (!worktree) throw new Error(copy.tasks.noWorktree);
      const settings = projectSettingsOfOrDefault(model, projectId);
      const firstMessage = await prompt();
      const r = await command('session.spawn', {
        projectId,
        agent: settings.defaultAgent,
        worktree: { kind: 'existing', worktreeId: worktree.id },
        firstMessage,
        toggles: {
          autoApproveEdits: false,
          mayRequestTargets: purpose === 'learn-deploy',
          notifyWhenNeedsMe: settings.notifyWhenNeedsMe,
        },
        model: null,
        permissionMode: 'default',
        effort: null,
        purpose,
        ...(targetId ? { taskTargetId: targetId } : {}),
      });
      if (!r.ok) throw new Error(r.error.message);
      ui.setTaskLaunch(key, { ...launch, sessionId: r.value.sessionId });
      ui.setLearning(key, r.value.sessionId);
      return r.value.sessionId;
    } catch (err) {
      ui.setTaskLaunch(key, { ...launch, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  };
  const result = run().finally(() => pending.delete(key));
  pending.set(key, result);
  return result;
}

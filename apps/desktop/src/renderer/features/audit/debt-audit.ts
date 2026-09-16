import { copy, type ProjectId, type ReadModel } from '@styx/core';
import { launchTask } from '../tasks/task-launch';

/** The repo audit remains a prompt to the project's agent, presented as a background task. */
export const startDebtAudit = async (
  model: ReadModel,
  projectId: ProjectId,
): Promise<{ sessionId: string } | null> => {
  const sessionId = await launchTask(
    model,
    projectId,
    `audit:${projectId}`,
    'debt-audit',
    async () => copy.debtAudit.prompt,
  );
  return sessionId ? { sessionId } : null;
};

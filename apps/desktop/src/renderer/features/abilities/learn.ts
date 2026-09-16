import {
  copy,
  fill,
  projectNameOf,
  type ProjectId,
  type ReadModel,
  type SessionId,
  type Target,
  type TargetId,
  activeTask,
} from '@styx/core';
import { command } from '../../state/commands';
import { launchTask } from '../tasks/task-launch';

/** Keys of `ui.learning`: which session is working an ability out for a project (run) or a target (deploy). */
export const learnKey = {
  run: (projectId: ProjectId): string => `run:${projectId}`,
  deploy: (targetId: TargetId): string => `deploy:${targetId}`,
};

type Suggestion = { command: string; source: string };

/** Styx's own detection, handed to the agent as a hint it must verify (never run blindly). */
const guessText = (suggestions: readonly Suggestion[]): string =>
  suggestions.length === 0
    ? ''
    : fill(copy.agentPrompt.guess, {
        guesses: suggestions.map((s) => `\`${s.command}\` (from ${s.source})`).join('; '),
      });

/**
 * "Run this project locally": the agent works it out, Styx remembers the command and starts it. With `failed`,
 * a new background task fixes the remembered command (the output is in the run strip; the agent gets
 * the command and what went wrong).
 */
export const startLearnRun = async (
  model: ReadModel,
  projectId: ProjectId,
  failed?: { command: string; failure: string },
): Promise<SessionId | null> =>
  launchTask(model, projectId, learnKey.run(projectId), 'learn-run', async () => {
    const project = projectNameOf(model, projectId);
    let prompt: string;
    if (failed === undefined) {
      const detected = await command('run.detect', { projectId });
      const hints = detected.ok ? guessText(detected.value.suggestions) : '';
      prompt = fill(copy.agentPrompt.learnRun, { project, hints });
    } else {
      prompt = fill(copy.agentPrompt.fixRun, { project, command: failed.command, failure: failed.failure });
    }
    return prompt;
  });

/** "Deploy": the agent works out the command for this target, deploys under a grant, and teaches Styx the command. */
export const startLearnDeploy = async (model: ReadModel, target: Target): Promise<SessionId | null> =>
  launchTask(
    model,
    target.projectId,
    learnKey.deploy(target.id),
    'learn-deploy',
    async () => {
      const project = projectNameOf(model, target.projectId);
      const detected = await command('deploy.detect', { targetId: target.id });
      // A committed `.styx/project.json` can seed target config: only a plain identifier goes into the message.
      const providerProject = target.config['projectId'];
      const hints = [
        ...(typeof providerProject === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(providerProject)
          ? [`, provider project ${providerProject}`]
          : []),
        ...(detected.ok ? [guessText(detected.value.suggestions)] : []),
      ].join('');
      const prompt = fill(copy.agentPrompt.learnDeploy, {
        project,
        target: `${target.name} ${target.env}`,
        provider: copy.providers[target.provider],
        env: target.env,
        hints,
        targetId: target.id,
      });
      return prompt;
    },
    target.id,
  );

/** The session working `key` out, if it is still alive (the row exists and is not done); null otherwise. */
export const learningSession = (
  model: ReadModel,
  learning: Readonly<Record<string, SessionId>>,
  key: string,
): SessionId | null => {
  const task = activeTask(model, key);
  if (task) return task.id;
  const sessionId = learning[key];
  if (sessionId === undefined) return null;
  const session = model.sessions.byId[sessionId];
  return session !== undefined && session.state !== 'done' ? sessionId : null;
};

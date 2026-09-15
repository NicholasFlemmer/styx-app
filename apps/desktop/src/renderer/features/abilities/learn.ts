import {
  copy,
  fill,
  mainWorktreeOf,
  projectNameOf,
  projectSettingsOfOrDefault,
  type ProjectId,
  type ReadModel,
  type SessionId,
  type Target,
  type TargetId,
} from '@styx/core';
import { command } from '../../state/commands';
import { useUiStore } from '../../state/ui-store';

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
 * The AI-native path for a button Styx cannot fulfil mechanically yet (owner principle): hand it to the project's
 * agent in chat with a task, let it ask what it needs, and let it teach Styx the result through the
 * `remember_command` MCP tool. From then on the button runs the remembered command itself. Same shape as the debt
 * audit: a real session in the main worktree; edits are not auto-approved.
 */
const spawnFor = async (
  model: ReadModel,
  projectId: ProjectId,
  firstMessage: string,
  mayRequestTargets: boolean,
): Promise<SessionId | null> => {
  const worktree = mainWorktreeOf(model, projectId);
  if (worktree === null) return null;
  const settings = projectSettingsOfOrDefault(model, projectId);
  const r = await command('session.spawn', {
    projectId,
    agent: settings.defaultAgent,
    worktree: { kind: 'existing', worktreeId: worktree.id },
    firstMessage,
    toggles: { autoApproveEdits: false, mayRequestTargets, notifyWhenNeedsMe: settings.notifyWhenNeedsMe },
    model: null,
    permissionMode: 'default',
    effort: null,
  });
  return r.ok ? r.value.sessionId : null;
};

const remember = (projectId: ProjectId, key: string, sessionId: SessionId | null): void => {
  if (!sessionId) return;
  const ui = useUiStore.getState();
  ui.setLearning(key, sessionId);
  ui.openSession(projectId, sessionId);
};

/**
 * "Run this project locally": the agent works it out, Styx remembers the command and starts it. With `failed`,
 * the same session is asked to fix the remembered command instead (the output is in the run strip; the agent gets
 * the command and what went wrong).
 */
export const startLearnRun = async (
  model: ReadModel,
  projectId: ProjectId,
  failed?: { command: string; failure: string },
): Promise<SessionId | null> => {
  const project = projectNameOf(model, projectId);
  let prompt: string;
  if (failed === undefined) {
    const detected = await command('run.detect', { projectId });
    const hints = detected.ok ? guessText(detected.value.suggestions) : '';
    prompt = fill(copy.agentPrompt.learnRun, { project, hints });
  } else {
    prompt = fill(copy.agentPrompt.fixRun, { project, command: failed.command, failure: failed.failure });
  }
  const sessionId = await spawnFor(model, projectId, prompt, false);
  remember(projectId, learnKey.run(projectId), sessionId);
  return sessionId;
};

/** "Deploy": the agent works out the command for this target, deploys under a grant, and teaches Styx the command. */
export const startLearnDeploy = async (model: ReadModel, target: Target): Promise<SessionId | null> => {
  const project = projectNameOf(model, target.projectId);
  const detected = await command('deploy.detect', { targetId: target.id });
  const providerProject = target.config['projectId'];
  const hints = [
    ...(typeof providerProject === 'string' && providerProject !== ''
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
  const sessionId = await spawnFor(model, target.projectId, prompt, true);
  remember(target.projectId, learnKey.deploy(target.id), sessionId);
  return sessionId;
};

/** The session working `key` out, if it is still alive (the row exists and is not done); null otherwise. */
export const learningSession = (
  model: ReadModel,
  learning: Readonly<Record<string, SessionId>>,
  key: string,
): SessionId | null => {
  const sessionId = learning[key];
  if (sessionId === undefined) return null;
  const session = model.sessions.byId[sessionId];
  return session !== undefined && session.state !== 'done' ? sessionId : null;
};

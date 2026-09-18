// @vitest-environment jsdom
import {
  copy,
  fill,
  fixtures,
  mainWorktreeOf,
  projectSettingsOfOrDefault,
  type ReadModel,
  type Session,
} from '@styx/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUiStore } from '../../state/ui-store';
import { learnKey, learningSession, startLearnDeploy, startLearnRun } from './learn';

const { ids } = fixtures;
const acme = ids.project.acmeShop;
const model = fixtures.demoReadModel();
const calls = (name: string) =>
  (vi.mocked(window.styx.command).mock.calls as [string, unknown][])
    .filter((c) => c[0] === name)
    .map((c) => c[1]);

describe('learned abilities: the first Run locally / Deploy is a task for the project agent', () => {
  let spawnOk = true;
  beforeEach(() => {
    spawnOk = true;
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: fixtures.DEMO_NOW },
        command: vi.fn(async (name: string) => {
          if (name === 'session.spawn')
            return spawnOk
              ? { ok: true, value: { sessionId: 's-learn' } }
              : { ok: false, error: { code: 'cli-missing' } };
          if (name === 'run.detect')
            return {
              ok: true,
              value: { suggestions: [{ command: 'pnpm dev', source: 'package.json' }], platforms: ['web'] },
            };
          if (name === 'deploy.detect')
            return {
              ok: true,
              value: { suggestions: [{ command: 'gcloud run deploy api --source .', source: 'Cloud Run' }] },
            };
          return { ok: true, value: {} };
        }),
      },
    });
    useUiStore.setState({
      overlays: [],
      screen: 'home',
      platform: 'darwin',
      projectId: null,
      projectSession: {},
      learning: {},
      taskLaunches: {},
    });
  });
  afterEach(() => Object.assign(window, { styx: undefined }));

  it('startLearnRun: spawns the default agent in the main worktree with the learn prompt (plus the detection as a hint), remembers the session and opens progress without navigating', async () => {
    expect(await startLearnRun(model, acme)).toBe('s-learn');
    const settings = projectSettingsOfOrDefault(model, acme);
    expect(calls('session.spawn')).toEqual([
      {
        projectId: acme,
        agent: settings.defaultAgent,
        worktree: { kind: 'existing', worktreeId: mainWorktreeOf(model, acme)?.id },
        firstMessage: fill(copy.agentPrompt.learnRun, {
          project: 'acme-shop',
          hints: fill(copy.agentPrompt.guess, { guesses: '`pnpm dev` (from package.json)' }),
        }),
        toggles: {
          autoApproveEdits: false,
          mayRequestTargets: false,
          notifyWhenNeedsMe: settings.notifyWhenNeedsMe,
        },
        model: null,
        permissionMode: 'default',
        effort: null,
        purpose: 'learn-run',
      },
    ]);
    const ui = useUiStore.getState();
    expect(ui.learning).toEqual({ [learnKey.run(acme)]: 's-learn' });
    expect(ui.screen).toBe('home');
    expect(ui.projectId).toBeNull();
    expect(ui.projectSession[acme]).toBeUndefined();
    expect(ui.overlays).toContainEqual(
      expect.objectContaining({ kind: 'task', taskKey: learnKey.run(acme) }),
    );
  });

  it('startLearnRun with a failure: the fix prompt carries the command and what went wrong; no detection', async () => {
    await startLearnRun(model, acme, { command: 'pnpm dev', failure: 'exited with code 1' });
    expect(calls('run.detect')).toEqual([]);
    expect(calls('session.spawn')[0]).toMatchObject({
      firstMessage: fill(copy.agentPrompt.fixRun, {
        project: 'acme-shop',
        command: 'pnpm dev',
        failure: 'exited with code 1',
      }),
    });
  });

  it('startLearnDeploy: names the target, provider, env, provider project and the detection; may request targets', async () => {
    const gcp = model.targets.byId[ids.target.infraGcp];
    if (gcp === undefined) throw new Error('fixture');
    expect(await startLearnDeploy(model, gcp)).toBe('s-learn');
    expect(calls('deploy.detect')).toEqual([{ targetId: gcp.id }]);
    expect(calls('session.spawn')[0]).toMatchObject({
      projectId: ids.project.infraTools,
      firstMessage: fill(copy.agentPrompt.learnDeploy, {
        project: 'infra-tools',
        target: 'GCP infra staging',
        provider: copy.providers.gcp,
        env: 'staging',
        hints:
          ', provider project acme-infra' +
          fill(copy.agentPrompt.guess, { guesses: '`gcloud run deploy api --source .` (from Cloud Run)' }),
        targetId: gcp.id,
      }),
      toggles: { autoApproveEdits: false, mayRequestTargets: true },
      purpose: 'learn-deploy',
    });
    expect(useUiStore.getState().learning).toEqual({ [learnKey.deploy(gcp.id)]: 's-learn' });
    expect(useUiStore.getState().projectSession[ids.project.infraTools]).toBeUndefined();
    expect(useUiStore.getState().overlays).toContainEqual(
      expect.objectContaining({ kind: 'task', taskKey: learnKey.deploy(gcp.id) }),
    );
  });

  it('a spawn that fails leaves nothing behind', async () => {
    spawnOk = false;
    expect(await startLearnRun(model, acme)).toBeNull();
    expect(useUiStore.getState().learning).toEqual({});
    expect(useUiStore.getState().projectSession).toEqual({});
  });

  it('learningSession: alive while the session exists and is not done', () => {
    const learner = model.sessions.byId[ids.session.gemini];
    if (learner === undefined) throw new Error('fixture');
    const learning = { [learnKey.run(acme)]: learner.id };
    expect(learningSession(model, learning, learnKey.run(acme))).toBe(learner.id);
    expect(learningSession(model, learning, learnKey.run(ids.project.blogV2))).toBeNull();
    expect(
      learningSession(model, { [learnKey.run(acme)]: 'gone' as Session['id'] }, learnKey.run(acme)),
    ).toBeNull();
    const finished: ReadModel = {
      ...model,
      sessions: {
        ...model.sessions,
        byId: {
          ...model.sessions.byId,
          [learner.id]: { ...learner, state: 'done', endedAt: fixtures.DEMO_NOW },
        },
      },
    };
    expect(learningSession(finished, learning, learnKey.run(acme))).toBeNull();
  });
});

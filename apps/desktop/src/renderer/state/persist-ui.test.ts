// @vitest-environment jsdom
import { fixtures, type ProjectId, type SessionId } from '@styx/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startUiPersistence } from './persist-ui';
import { useUiStore } from './ui-store';

const { ids } = fixtures;
const acme = ids.project.acmeShop as ProjectId;
const blog = ids.project.blogV2 as ProjectId;

describe('ui persistence (README: ui.screen / projectId / per-project session survive a relaunch)', () => {
  const commands: { name: string; input: unknown }[] = [];
  let stop = () => {};
  beforeEach(() => {
    vi.useFakeTimers();
    commands.length = 0;
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: {},
        command: vi.fn(async (name: string, input: unknown) => {
          commands.push({ name, input });
          return { ok: true, value: {} };
        }),
      },
    });
    useUiStore.setState({
      screen: 'workspace',
      screenResolved: true,
      projectId: acme,
      projectSession: {},
      overlays: [],
    });
    stop = startUiPersistence();
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
    Object.assign(window, { styx: undefined });
  });

  it('writes the screen, project and chat tab once they settle, and only what changed', () => {
    useUiStore.getState().setScreen('settings');
    useUiStore.getState().setProject(blog);
    vi.advanceTimersByTime(400);
    expect(commands).toEqual([
      { name: 'ui.persist', input: { screen: 'settings', projectId: blog, projectSession: {} } },
    ]);
    useUiStore.getState().setSession(acme, ids.session.codex as SessionId);
    vi.advanceTimersByTime(400);
    expect(commands.at(-1)).toEqual({
      name: 'ui.persist',
      input: { projectSession: { [acme]: ids.session.codex } },
    });
  });

  it('never remembers a screen that has no tomorrow: the diff review and onboarding', () => {
    useUiStore.getState().setScreen('diff');
    vi.advanceTimersByTime(400);
    expect(commands.map((c) => c.input)).toEqual([{ projectId: acme, projectSession: {} }]);
    useUiStore.getState().setScreen('repo');
    vi.advanceTimersByTime(400);
    expect(commands.at(-1)?.input).toEqual({ screen: 'repo' });
  });
});

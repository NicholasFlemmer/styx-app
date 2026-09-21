// @vitest-environment jsdom
import { copy, fixtures, sessionTabs, boardColumns, taskKey, type Session } from '@styx/core';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRail } from '../../app/AppRail';
import { Nav } from '../../app/Nav';
import { OverlayHost } from '../../app/OverlayHost';
import { isTrapping } from '../../overlays/stack';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { startDebtAudit } from '../audit';
import { openTask } from './task-launch';

const ids = fixtures.ids;
const projectId = ids.project.acmeShop;
const auditKey = `audit:${projectId}`;
const calls = vi.fn();

function seedTask(patch: Partial<Session> = {}) {
  const model = fixtures.demoReadModel();
  const base = model.sessions.byId[ids.session.claude];
  if (!base) throw new Error('fixture');
  const session: Session = { ...base, purpose: 'debt-audit', state: 'working', pausedReason: null, ...patch };
  const messages = [
    {
      id: 'report' as never,
      sessionId: session.id,
      seq: 1,
      body: 'Audit report: duplicated checkout validation.',
      payload: { kind: 'agent' as const },
      askId: null,
      createdAt: fixtures.DEMO_NOW,
    },
  ];
  useReadModel.getState().replaceModel(
    {
      ...model,
      sessions: { ...model.sessions, byId: { ...model.sessions.byId, [session.id]: session } },
      transcripts: { ...model.transcripts, [session.id]: messages },
    },
    'connected',
  );
  return session;
}

beforeEach(() => {
  calls.mockReset().mockResolvedValue({ ok: true, value: {} });
  Object.assign(window, { styx: { command: calls, env: { now: fixtures.DEMO_NOW } } });
  useUiStore.setState({
    projectId,
    projectSession: {},
    screen: 'home',
    overlays: [],
    taskLaunches: {},
    learning: {},
  });
  useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
});
afterEach(() => {
  cleanup();
  Object.assign(window, { styx: undefined });
});

describe('background tasks', () => {
  it('shows feedback immediately, deduplicates clicks, and never steals navigation after spawn', async () => {
    let finish: ((value: unknown) => void) | undefined;
    calls.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const model = useReadModel.getState().model;
    const first = startDebtAudit(model, projectId);
    const second = startDebtAudit(model, projectId);
    expect(useUiStore.getState().taskLaunches[auditKey]?.sessionId).toBeNull();
    expect(isTrapping(useUiStore.getState().overlays)).toBe(false);
    useUiStore.getState().setProject(ids.project.blogV2);
    useUiStore.getState().closeOverlays();
    await waitFor(() => expect(calls).toHaveBeenCalledTimes(1));
    finish?.({ ok: true, value: { sessionId: 'task-new' } });
    await Promise.all([first, second]);
    expect(useUiStore.getState().projectId).toBe(ids.project.blogV2);
    expect(useUiStore.getState().screen).toBe('home');
    expect(useUiStore.getState().projectSession).toEqual({});
    expect(useUiStore.getState().overlays).toEqual([]);
  });

  it('keeps the dialog modeless, supports switching project, minimizing and reopening', () => {
    const task = seedTask();
    openTask(taskKey(task));
    render(
      <>
        <div id="layer-app">
          <AppRail />
          <Nav />
        </div>
        <OverlayHost />
      </>,
    );
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('false');
    expect(document.getElementById('layer-app')?.hasAttribute('inert')).toBe(false);
    act(() => useUiStore.getState().setProject(ids.project.blogV2));
    expect(screen.getByRole('dialog').textContent).toContain('acme-shop');
    fireEvent.click(screen.getByRole('button', { name: copy.tasks.background }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // Tasks moved to the app rail (owner layout #85); its tile reopens the dialog.
    fireEvent.click(screen.getByRole('button', { name: copy.appRail.tasks.title }));
    fireEvent.click(screen.getByRole('button', { name: /Tech debt audit · acme-shop/ }));
    expect(screen.getByRole('dialog').textContent).toContain('Audit report');
    expect(useUiStore.getState().projectId).toBe(ids.project.blogV2);
    expect(calls).not.toHaveBeenCalledWith('session.stop', expect.anything());
  });

  it('reopens a persisted report after renderer state is lost, without adding a chat or board card', () => {
    const task = seedTask({ state: 'done', endedAt: fixtures.DEMO_NOW, exitCode: 0 });
    const model = useReadModel.getState().model;
    expect(sessionTabs(model, projectId, task.id).visible.some((t) => t.sessionId === task.id)).toBe(false);
    expect(
      boardColumns(model, fixtures.DEMO_NOW)
        .flatMap((c) => c.items)
        .some((c) => c.sessionId === task.id),
    ).toBe(false);
    openTask(taskKey(task));
    render(<OverlayHost />);
    expect(screen.getByRole('status').textContent).toBe(copy.tasks.finished);
    expect(screen.getByText(/Audit report: duplicated checkout validation/)).toBeTruthy();
    expect(calls).not.toHaveBeenCalled();
  });

  it('routes notifications for hidden sessions into progress instead of changing the current chat', () => {
    const task = seedTask();
    useUiStore.getState().openSession(projectId, task.id);
    expect(useUiStore.getState().screen).toBe('home');
    expect(useUiStore.getState().projectSession).toEqual({});
    expect(useUiStore.getState().overlays).toContainEqual(
      expect.objectContaining({ kind: 'task', taskKey: auditKey }),
    );
  });

  it("shows the task's permission mode (bypass by default) and switching it sets the project's task mode and the running session", async () => {
    const task = seedTask({ state: 'working', permissionMode: 'bypassPermissions' });
    openTask(auditKey);
    render(<OverlayHost />);
    const select = screen.getByLabelText(copy.tasks.mode) as HTMLSelectElement;
    expect(select.value).toBe('bypassPermissions');
    expect(screen.getByText(copy.tasks.modeHint)).toBeTruthy();
    fireEvent.change(select, { target: { value: 'default' } });
    await waitFor(() =>
      expect(calls).toHaveBeenCalledWith('project.settings.set', {
        projectId,
        patch: { taskPermissionMode: 'default' },
      }),
    );
    expect(calls).toHaveBeenCalledWith('session.configure', {
      sessionId: task.id,
      permissionMode: 'default',
    });
    // A finished task is not reconfigured; the project setting still is.
    calls.mockClear();
    act(() => {
      seedTask({ state: 'done', exitCode: 0, permissionMode: 'bypassPermissions' });
    });
    fireEvent.change(screen.getByLabelText(copy.tasks.mode), { target: { value: 'acceptEdits' } });
    await waitFor(() => expect(calls).toHaveBeenCalledWith('project.settings.set', expect.anything()));
    expect(calls).not.toHaveBeenCalledWith('session.configure', expect.anything());
  });

  it('answers an approval inside the task, while keeping its agent hidden', async () => {
    const task = seedTask({ state: 'needs-you' });
    const model = useReadModel.getState().model;
    const askId = 'task-approval' as never;
    useReadModel.getState().replaceModel(
      {
        ...model,
        pendingAsks: {
          ids: [askId],
          byId: {
            [askId]: {
              id: askId,
              sessionId: task.id,
              kind: 'decision',
              grantId: null,
              payload: {
                kind: 'decision',
                prompt: 'Run the verification command?',
                options: ['Allow', 'Deny'],
              },
              state: 'open',
              resolution: null,
              position: 0,
              brokerRequestId: null,
              createdAt: fixtures.DEMO_NOW,
              resolvedAt: null,
            },
          },
        },
      },
      'connected',
    );
    openTask(auditKey);
    render(<OverlayHost />);
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() =>
      expect(calls).toHaveBeenCalledWith('ask.respond', {
        askId,
        resolution: { kind: 'decision', chosen: 'Allow' },
      }),
    );
    expect(useUiStore.getState().projectSession).toEqual({});
  });

  it('shows failed startup with retry, and does not show the previous result while retrying', async () => {
    seedTask({ state: 'done', endedAt: fixtures.DEMO_NOW, exitCode: 0 });
    calls.mockResolvedValue({ ok: false, error: { code: 'internal', message: 'Unable to launch agent' } });
    await startDebtAudit(useReadModel.getState().model, projectId);
    render(<OverlayHost />);
    expect(screen.getByRole('dialog').textContent).toContain('Unable to launch agent');
    expect(screen.queryByText(/Audit report: duplicated/)).toBeNull();
    let finish: ((value: unknown) => void) | undefined;
    calls.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(screen.getByRole('button', { name: copy.tasks.retry }));
    expect(within(screen.getByRole('dialog')).getByRole('status').textContent).toBe(copy.tasks.starting);
    await waitFor(() => expect(finish).toBeDefined());
    await act(async () => {
      finish?.({ ok: true, value: { sessionId: 'retried-task' } });
    });
  });
});

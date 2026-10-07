// @vitest-environment jsdom
import { copy, fixtures, type Deploy, type ReadModel } from '@styx/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { ToastHost } from './ToastHost';

const { ids, DEMO_NOW } = fixtures;
const acme = ids.project.acmeShop;
const vercelProd = ids.target.vercelProd;

const deploy = (over: Partial<Deploy> = {}): Deploy => ({
  deployId: 'dep:1',
  targetId: vercelProd,
  projectId: acme,
  phase: 'running',
  terminalId: 'term:1',
  exitCode: null,
  error: null,
  startedAt: DEMO_NOW - 60_000,
  endedAt: null,
  ...over,
});

const setDeploys = (deploys: Record<string, Deploy>, dnd = false) => {
  act(() => {
    const st = useReadModel.getState();
    const next: ReadModel = {
      ...st.model,
      deploys,
      settings: { ...st.model.settings, app: { ...st.model.settings.app, dnd } },
    };
    st.replaceModel(next, 'connected');
  });
};

const toasts = () => useUiStore.getState().overlays.filter((o) => o.kind === 'toast');
const modals = () => useUiStore.getState().overlays.filter((o) => o.kind === 'modal');

describe('ToastHost · deploy finish toast', () => {
  beforeEach(() => {
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: DEMO_NOW },
        command: vi.fn(async () => ({ ok: true, value: {} })),
        onEvent: () => () => undefined,
      },
    });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({ overlays: [], screen: 'workspace', platform: 'darwin', projectId: acme });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('a deploy going running → succeeded with no modal open pushes a toast; Show output opens the modal on it', () => {
    render(<ToastHost />);
    setDeploys({ 'dep:1': deploy() });
    expect(toasts()).toEqual([]);
    setDeploys({ 'dep:1': deploy({ phase: 'succeeded', exitCode: 0, endedAt: DEMO_NOW }) });
    expect(toasts()).toEqual([
      expect.objectContaining({
        kind: 'toast',
        toast: { kind: 'deploy', deployId: 'dep:1', targetId: vercelProd },
      }),
    ]);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Deploy · Vercel prod');
    expect(status.textContent).toContain('Deployed · Vercel prod');
    fireEvent.click(screen.getByRole('button', { name: copy.deploy.showOutput }));
    expect(toasts()).toEqual([]);
    expect(modals()[0]).toMatchObject({ modal: 'deploy', targetId: vercelProd, deployId: 'dep:1' });
  });

  it('a failure names the target and carries the error or exit code', () => {
    render(<ToastHost />);
    setDeploys({ 'dep:1': deploy() });
    setDeploys({ 'dep:1': deploy({ phase: 'failed', exitCode: 1, endedAt: DEMO_NOW }) });
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Deploy failed · Vercel prod');
    expect(status.textContent).toContain('exit 1');

    useUiStore.setState({ overlays: [] });
    setDeploys({ 'dep:2': deploy({ deployId: 'dep:2' }) });
    setDeploys({
      'dep:2': deploy({
        deployId: 'dep:2',
        phase: 'failed',
        error: 'vercel not found on PATH',
        endedAt: DEMO_NOW,
      }),
    });
    expect(screen.getByRole('status').textContent).toContain('vercel not found on PATH');
  });

  it('no toast while a deploy modal for that deploy (or one that started it) is open', () => {
    render(<ToastHost />);
    setDeploys({ 'dep:1': deploy() });
    useUiStore.setState({ overlays: [{ id: 'm1', kind: 'modal', modal: 'deploy', targetId: vercelProd }] });
    setDeploys({ 'dep:1': deploy({ phase: 'succeeded', exitCode: 0, endedAt: DEMO_NOW }) });
    expect(toasts()).toEqual([]);

    useUiStore.setState({
      overlays: [{ id: 'm2', kind: 'modal', modal: 'deploy', targetId: vercelProd, deployId: 'dep:2' }],
    });
    setDeploys({ 'dep:2': deploy({ deployId: 'dep:2' }) });
    setDeploys({ 'dep:2': deploy({ deployId: 'dep:2', phase: 'failed', exitCode: 1, endedAt: DEMO_NOW }) });
    expect(toasts()).toEqual([]);
  });

  it('cancelled, rows that arrive already finished, a repeat, and DND all stay quiet', () => {
    render(<ToastHost />);
    setDeploys({ 'dep:1': deploy() });
    setDeploys({ 'dep:1': deploy({ phase: 'cancelled', exitCode: 130, endedAt: DEMO_NOW }) });
    expect(toasts()).toEqual([]);
    // Already finished when first seen (snapshot): history, not news.
    setDeploys({
      'dep:2': deploy({ deployId: 'dep:2', phase: 'succeeded', exitCode: 0, endedAt: DEMO_NOW }),
    });
    expect(toasts()).toEqual([]);
    // The same finished row arriving again does not stack a second toast.
    setDeploys({ 'dep:3': deploy({ deployId: 'dep:3' }) });
    setDeploys({
      'dep:3': deploy({ deployId: 'dep:3', phase: 'succeeded', exitCode: 0, endedAt: DEMO_NOW }),
    });
    setDeploys({
      'dep:3': deploy({ deployId: 'dep:3', phase: 'succeeded', exitCode: 0, endedAt: DEMO_NOW + 1 }),
    });
    expect(toasts()).toHaveLength(1);
    useUiStore.setState({ overlays: [] });
    // Do not disturb.
    setDeploys({ 'dep:4': deploy({ deployId: 'dep:4' }) }, true);
    setDeploys(
      { 'dep:4': deploy({ deployId: 'dep:4', phase: 'succeeded', exitCode: 0, endedAt: DEMO_NOW }) },
      true,
    );
    expect(toasts()).toEqual([]);
  });
});

describe('ToastHost · one needs-you toast per ask', () => {
  it('a repeated ask.opened (reconnect, re-publish) adds no second toast, even under another toast', () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: DEMO_NOW },
        command: vi.fn(async () => ({ ok: true, value: {} })),
        onEvent: (name: string, cb: (payload: unknown) => void) => {
          listeners.set(name, cb);
          return () => listeners.delete(name);
        },
      },
    });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({ overlays: [], screen: 'workspace', platform: 'darwin', projectId: acme });
    render(<ToastHost />);
    const ask = {
      askId: fixtures.ids.ask.codexGrant,
      sessionId: fixtures.ids.session.codex,
      projectId: acme,
    };
    act(() => listeners.get('ask.opened')?.(ask));
    expect(toasts()).toHaveLength(1);
    // An error toast lands on top; the same ask arrives again.
    act(() => {
      useUiStore.getState().pushOverlay({ kind: 'toast', toast: { kind: 'error', code: 'x', message: 'y' } });
      listeners.get('ask.opened')?.(ask);
    });
    expect(toasts().filter((o) => o.kind === 'toast' && o.toast.kind === 'ask')).toHaveLength(1);
    // Answered elsewhere: the toast goes with the ask.
    act(() => {
      const st = useReadModel.getState();
      const row = st.model.pendingAsks.byId[ask.askId];
      if (!row) throw new Error('fixture ask');
      st.replaceModel(
        {
          ...st.model,
          pendingAsks: {
            ...st.model.pendingAsks,
            byId: { ...st.model.pendingAsks.byId, [ask.askId]: { ...row, state: 'resolved' } },
          },
        },
        'connected',
      );
    });
    expect(toasts().filter((o) => o.kind === 'toast' && o.toast.kind === 'ask')).toHaveLength(0);
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('Notify when an agent needs me › Off (issue #4) shows no needs-you toast', () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: DEMO_NOW },
        command: vi.fn(async () => ({ ok: true, value: {} })),
        onEvent: (name: string, cb: (payload: unknown) => void) => {
          listeners.set(name, cb);
          return () => listeners.delete(name);
        },
      },
    });
    const m = fixtures.demoReadModel();
    useReadModel
      .getState()
      .replaceModel({ ...m, settings: { ...m.settings, app: { ...m.settings.app, notify: 'off' } } }, 'connected');
    useUiStore.setState({ overlays: [], screen: 'workspace', platform: 'darwin', projectId: acme });
    render(<ToastHost />);
    act(() =>
      listeners.get('ask.opened')?.({
        askId: fixtures.ids.ask.codexGrant,
        sessionId: fixtures.ids.session.codex,
        projectId: acme,
      }),
    );
    expect(toasts()).toEqual([]);
    cleanup();
    Object.assign(window, { styx: undefined });
  });
});

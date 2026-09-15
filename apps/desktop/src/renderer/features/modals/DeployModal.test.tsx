// @vitest-environment jsdom
import { copy, fixtures, type Deploy, type ReadModel } from '@styx/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { DeployModal } from './DeployModal';

// xterm needs a real layout engine; the modal only needs the entry to be created, attached and disposed.
vi.mock('./login-terminal', () => ({
  createLoginTerminal: vi.fn((terminalId: string) => ({
    terminalId,
    term: { focus: vi.fn(), dispose: vi.fn() },
  })),
  disposeLoginTerminal: vi.fn(),
}));
vi.mock('../terminal/terminal-registry', () => ({
  attachTerminal: vi.fn(),
  detachTerminal: vi.fn(),
  isReservedKey: () => false,
}));
const loginTerminal = await import('./login-terminal');
const registry = await import('../terminal/terminal-registry');

const { ids, DEMO_NOW } = fixtures;
const acme = ids.project.acmeShop;
const vercelProd = ids.target.vercelProd;

const listeners = new Map<string, Set<(payload: unknown) => void>>();
const emit = (name: string, payload: unknown) => {
  act(() => {
    for (const cb of listeners.get(name) ?? []) cb(payload);
  });
};

let startResult:
  | { ok: true; value: { deployId: string; terminalId: string } }
  | { ok: false; error: { code: string; message: string } }
  | null = {
  ok: true,
  value: { deployId: 'dep:1', terminalId: 'term:1' },
};
const commandMock = vi.fn(async (name: string, _input?: unknown) => {
  // `null` = the start never resolves (the id stays unknown), which is the window the event fallback covers.
  if (name === 'deploy.start') return startResult ?? new Promise<never>(() => undefined);
  return { ok: true as const, value: {} };
});
const calls = (name: string) => commandMock.mock.calls.filter((c) => c[0] === name);

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

/** Applies a deploy row to the mirrored model the way a `deploys.set` delta would. */
const setDeploy = (d: Deploy) => {
  act(() => {
    const st = useReadModel.getState();
    const next: ReadModel = { ...st.model, deploys: { ...st.model.deploys, [d.deployId]: d } };
    st.replaceModel(next, 'connected');
  });
};

describe('DeployModal', () => {
  beforeEach(() => {
    commandMock.mockClear();
    vi.mocked(loginTerminal.createLoginTerminal).mockClear();
    vi.mocked(registry.attachTerminal).mockClear();
    vi.mocked(registry.detachTerminal).mockClear();
    listeners.clear();
    startResult = { ok: true, value: { deployId: 'dep:1', terminalId: 'term:1' } };
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: DEMO_NOW },
        command: commandMock,
        onEvent: (name: string, cb: (payload: unknown) => void) => {
          const set = listeners.get(name) ?? new Set();
          set.add(cb);
          listeners.set(name, set);
          return () => set.delete(cb);
        },
      },
    });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({
      overlays: [{ id: 'modal-1', kind: 'modal', modal: 'deploy', targetId: vercelProd }],
      screen: 'workspace',
      platform: 'darwin',
      projectId: acme,
    });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('starts the deploy for the target and then renders the model row: phase, terminal, exit code', async () => {
    render(<DeployModal id="modal-1" targetId={vercelProd} />);
    expect(screen.getByRole('dialog').textContent).toContain('Deploy · Vercel prod');
    await waitFor(() => expect(calls('deploy.start')).toHaveLength(1));
    expect(calls('deploy.start')[0]?.[1]).toEqual({ targetId: vercelProd });
    expect(screen.getByText(copy.deploy.phases['requesting-grant'])).toBeTruthy();

    // Once the id is known the deploys slice drives the modal.
    setDeploy(deploy());
    await waitFor(() => expect(screen.getByText(copy.deploy.phases.running)).toBeTruthy());
    expect(loginTerminal.createLoginTerminal).toHaveBeenCalledWith('term:1', { screenReader: false });
    expect(registry.attachTerminal).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: copy.deploy.cancel })).toBeTruthy();

    setDeploy(deploy({ phase: 'failed', exitCode: 1, endedAt: DEMO_NOW }));
    await waitFor(() => expect(screen.getByText(copy.deploy.phases.failed)).toBeTruthy());
    expect(screen.getByText('exit 1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: copy.deploy.cancel })).toBeNull();
    // The terminal was attached once: the row's terminalId did not change.
    expect(loginTerminal.createLoginTerminal).toHaveBeenCalledTimes(1);
  });

  it('with a deployId it attaches to the running deploy and never calls deploy.start', async () => {
    setDeploy(deploy());
    render(<DeployModal id="modal-1" targetId={vercelProd} deployId="dep:1" />);
    expect(screen.getByText(copy.deploy.phases.running)).toBeTruthy();
    await waitFor(() => expect(registry.attachTerminal).toHaveBeenCalledTimes(1));
    expect(loginTerminal.createLoginTerminal).toHaveBeenCalledWith('term:1', { screenReader: false });
    expect(calls('deploy.start')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: copy.deploy.cancel }));
    expect(calls('deploy.cancel')).toEqual([['deploy.cancel', { deployId: 'dep:1' }]]);

    setDeploy(deploy({ phase: 'succeeded', exitCode: 0, endedAt: DEMO_NOW }));
    await waitFor(() => expect(screen.getByText(copy.deploy.phases.succeeded)).toBeTruthy());
    expect(screen.queryByText(/^exit /)).toBeNull();
  });

  it('a finished deploy re-opened from the toast shows its error and output, with nothing to cancel', async () => {
    setDeploy(deploy({ phase: 'failed', exitCode: 2, error: 'vercel not found on PATH', endedAt: DEMO_NOW }));
    render(<DeployModal id="modal-1" targetId={vercelProd} deployId="dep:1" />);
    expect(screen.getByText(copy.deploy.phases.failed)).toBeTruthy();
    expect(screen.getByText('vercel not found on PATH')).toBeTruthy();
    expect(screen.getByText('exit 2')).toBeTruthy();
    expect(screen.queryByRole('button', { name: copy.deploy.cancel })).toBeNull();
    await waitFor(() => expect(registry.attachTerminal).toHaveBeenCalledTimes(1));
  });

  it('a refused start shows the error from the command result', async () => {
    startResult = { ok: false, error: { code: 'invalid-input', message: copy.deploy.notConnected } };
    render(<DeployModal id="modal-1" targetId={vercelProd} />);
    await waitFor(() => expect(screen.getByText(copy.deploy.phases.failed)).toBeTruthy());
    expect(screen.getByText(copy.deploy.notConnected)).toBeTruthy();
    expect(registry.attachTerminal).not.toHaveBeenCalled();
  });

  it('progress events still fill in before the id is known, and only for this target', async () => {
    startResult = null;
    render(<DeployModal id="modal-1" targetId={vercelProd} />);
    emit('deploy.progress', {
      deployId: 'dep:9',
      targetId: ids.target.vercelPreview,
      phase: 'running',
      exitCode: null,
      error: null,
      terminalId: 'term:9',
    });
    expect(loginTerminal.createLoginTerminal).not.toHaveBeenCalled();
    emit('deploy.progress', {
      deployId: 'dep:1',
      targetId: vercelProd,
      phase: 'running',
      exitCode: null,
      error: null,
      terminalId: 'term:1',
    });
    await waitFor(() => expect(loginTerminal.createLoginTerminal).toHaveBeenCalledWith('term:1', { screenReader: false }));
    expect(screen.getByText(copy.deploy.phases.running)).toBeTruthy();
  });

  it('unmounting detaches and disposes the terminal; Close pops the overlay', async () => {
    setDeploy(deploy());
    const { unmount } = render(<DeployModal id="modal-1" targetId={vercelProd} deployId="dep:1" />);
    await waitFor(() => expect(registry.attachTerminal).toHaveBeenCalledTimes(1));
    // The Modal's ✕ is also named "Close"; the footer button is the last one.
    const closeButtons = screen.getAllByRole('button', { name: copy.deploy.close });
    fireEvent.click(closeButtons[closeButtons.length - 1] as HTMLElement);
    expect(useUiStore.getState().overlays).toEqual([]);
    unmount();
    expect(registry.detachTerminal).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(loginTerminal.createLoginTerminal).mock.results[0]?.value as {
      term: { dispose: ReturnType<typeof vi.fn> };
    };
    expect(entry.term.dispose).toHaveBeenCalledTimes(1);
  });
});

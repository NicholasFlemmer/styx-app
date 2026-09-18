// @vitest-environment jsdom
import { copy, fixtures, type CliInstall, type ReadModel } from '@styx/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { ConnectAgentModal } from './ConnectAgentModal';

// xterm needs a real layout engine; the modal only needs the entry to be created, attached and disposed.
vi.mock('./login-terminal', () => ({
  createLoginTerminal: vi.fn((terminalId: string) => ({ terminalId, term: { focus: vi.fn() } })),
  disposeLoginTerminal: vi.fn(),
}));
vi.mock('../terminal/terminal-registry', () => ({
  attachTerminal: vi.fn(),
  detachTerminal: vi.fn(),
  isReservedKey: () => false,
}));
const loginTerminal = await import('./login-terminal');

const acme = fixtures.ids.project.acmeShop;

const listeners = new Map<string, Set<(payload: unknown) => void>>();
const emit = (name: string, payload: unknown) => {
  act(() => {
    for (const cb of listeners.get(name) ?? []) cb(payload);
  });
};

let verifyOk = true;
let pickedPath: string | null = '/opt/homebrew/bin/gemini';
let setBinaryError: string | null = null;
const commandMock = vi.fn(async (name: string, _input?: unknown) => {
  switch (name) {
    case 'detect.setBinary':
      return setBinaryError === null
        ? { ok: true as const, value: {} }
        : { ok: false as const, error: { code: 'invalid-input', message: setBinaryError } };
    case 'agent.verify':
      return verifyOk
        ? { ok: true as const, value: { cli: fixtures.demoClis()[0] } }
        : { ok: false as const, error: { code: 'internal', message: 'main went away' } };
    case 'agent.login':
      return { ok: true as const, value: { terminalId: 'term-login-1', command: 'gemini' } };
    case 'dialog.pickFile':
      return { ok: true as const, value: { path: pickedPath } };
    default:
      return { ok: true as const, value: {} };
  }
});
const calls = (name: string) => commandMock.mock.calls.filter((c) => c[0] === name);

/** Demo model with one CLI row swapped. */
const withCli = (agent: CliInstall['agent'], patch: Partial<CliInstall>): ReadModel => {
  const m = fixtures.demoReadModel();
  const clis = m.discovery.clis.map((c) => (c.agent === agent ? { ...c, ...patch } : c));
  return { ...m, discovery: { ...m.discovery, clis } };
};
const seed = (model: ReadModel = fixtures.demoReadModel()) =>
  act(() => useReadModel.getState().replaceModel(model, 'connected'));

const identity = () => document.querySelector('[data-agent-identity]');

describe('ConnectAgentModal', () => {
  beforeEach(() => {
    commandMock.mockClear();
    vi.mocked(loginTerminal.createLoginTerminal).mockClear();
    vi.mocked(loginTerminal.disposeLoginTerminal).mockClear();
    listeners.clear();
    verifyOk = true;
    pickedPath = '/opt/homebrew/bin/gemini';
    setBinaryError = null;
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: fixtures.DEMO_NOW },
        command: commandMock,
        onEvent: (name: string, cb: (payload: unknown) => void) => {
          const set = listeners.get(name) ?? new Set();
          set.add(cb);
          listeners.set(name, set);
          return () => set.delete(cb);
        },
      },
    });
    seed();
    useUiStore.setState({
      overlays: [{ id: 'modal-1', kind: 'modal', modal: 'connect-agent', agent: 'gemini' }],
      screen: 'settings',
      platform: 'darwin',
      projectId: acme,
    });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('opens on the heading, verifies the CLI, and shows where it lives and that it is not signed in', async () => {
    render(<ConnectAgentModal id="modal-1" agent="gemini" />);
    expect(screen.getByRole('dialog').textContent).toContain('Connect agent · Gemini CLI');
    expect(screen.getByText('Connect Gemini CLI')).toBeTruthy();
    expect(document.activeElement?.textContent).toBe('Connect Gemini CLI');
    expect(screen.getByText(/Sign-in happens in gemini's own flow/)).toBeTruthy();
    const status = document.querySelector('[data-cli-installed]');
    expect(status?.getAttribute('data-cli-installed')).toBe('true');
    expect(status?.textContent).toBe('gemini 1.2.0 · /opt/homebrew/bin/gemini');
    await waitFor(() => expect(calls('agent.verify')).toEqual([['agent.verify', { agent: 'gemini' }]]));
    await waitFor(() => expect(identity()?.getAttribute('data-agent-identity')).toBe('signed-out'));
    expect(identity()?.textContent).toBe(copy.agentsPage.connect.notSignedIn);
    expect(identity()?.getAttribute('aria-live')).toBe('polite');
    expect(screen.getByRole('button', { name: 'Sign in with gemini…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: copy.agentsPage.connect.verify })).toBeTruthy();
    expect(screen.getByRole('button', { name: copy.agentsPage.connect.done })).toBeTruthy();
  });

  it('a connected CLI reads Signed in as <account>; an unverified one reads Not verified yet', async () => {
    render(<ConnectAgentModal id="modal-1" agent="claude" />);
    await waitFor(() => expect(identity()?.getAttribute('data-agent-identity')).toBe('connected'));
    expect(identity()?.textContent).toBe('Signed in as nic@acme.dev');
    expect(identity()?.querySelector('[data-tone]')?.getAttribute('data-on')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in with claude…' })).toBeTruthy();
    cleanup();
    render(<ConnectAgentModal id="modal-1" agent="cursor" />);
    await waitFor(() => expect(identity()?.getAttribute('data-agent-identity')).toBe('unverified'));
    expect(identity()?.textContent).toBe(copy.agentsPage.connect.unverified);
    expect(screen.getByRole('button', { name: 'Sign in with cursor-agent…' })).toBeTruthy();
  });

  it('reads checking… while a verify runs and check failed when the row or the command says so', async () => {
    let release: (() => void) | null = null;
    commandMock.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ok: true as const, value: { cli: fixtures.demoClis()[0] } };
    });
    render(<ConnectAgentModal id="modal-1" agent="gemini" />);
    await waitFor(() => expect(identity()?.textContent).toBe('Checking gemini…'));
    expect(
      (screen.getByRole('button', { name: copy.agentsPage.connect.verify }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => {
      release?.();
    });
    await waitFor(() => expect(identity()?.getAttribute('data-agent-identity')).toBe('signed-out'));
    // The CLI's own failure arrives on the row through the store.
    seed(withCli('gemini', { verifyError: 'spawn ENOENT' }));
    expect(identity()?.textContent).toBe("Couldn't verify: spawn ENOENT");
    // The command itself failing (main unreachable) reads the same way.
    seed();
    verifyOk = false;
    fireEvent.click(screen.getByRole('button', { name: copy.agentsPage.connect.verify }));
    await waitFor(() => expect(identity()?.textContent).toBe("Couldn't verify: main went away"));
    expect(calls('agent.verify')).toHaveLength(2);
  });

  it('Sign in runs agent.login, mounts the inline terminal, follows the exit and the re-verified row', async () => {
    render(<ConnectAgentModal id="modal-1" agent="gemini" />);
    await waitFor(() => expect(calls('agent.verify')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with gemini…' }));
    await waitFor(() => expect(calls('agent.login')).toEqual([['agent.login', { agent: 'gemini' }]]));
    await waitFor(() => expect(document.querySelector('[data-login-terminal="term-login-1"]')).toBeTruthy());
    expect(loginTerminal.createLoginTerminal).toHaveBeenCalledWith('term-login-1', { screenReader: false });
    expect(screen.getByText('Waiting for gemini…')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Sign in with gemini…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // Another terminal's exit is not ours.
    emit('agent.login', { terminalId: 'other', agent: 'codex', status: 'exited', exitCode: 0 });
    expect(document.querySelector('[data-login-terminal]')).toBeTruthy();
    // A failed login keeps the terminal with the exit code in its label.
    emit('agent.login', { terminalId: 'term-login-1', agent: 'gemini', status: 'exited', exitCode: 1 });
    expect(screen.getByText('gemini exited with code 1.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Sign in with gemini…' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    // Try again: a clean exit drops the terminal; main re-verified, so the row in the model now says who we are.
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with gemini…' }));
    await waitFor(() => expect(calls('agent.login')).toHaveLength(2));
    emit('agent.login', { terminalId: 'term-login-1', agent: 'gemini', status: 'exited', exitCode: 0 });
    await waitFor(() => expect(document.querySelector('[data-login-terminal]')).toBeNull());
    expect(loginTerminal.disposeLoginTerminal).toHaveBeenCalled();
    seed(
      withCli('gemini', { authState: 'signed-in', account: 'nic@gmail.com', verifiedAt: fixtures.DEMO_NOW }),
    );
    expect(identity()?.getAttribute('data-agent-identity')).toBe('connected');
    expect(identity()?.textContent).toBe('Signed in as nic@gmail.com');
    expect(document.querySelector('[data-cli-installed]')?.textContent).toBe(
      'gemini 1.2.0 · /opt/homebrew/bin/gemini',
    );
  });

  it('a missing CLI offers Install guide and Locate binary (→ detect.setBinary, then a verify), no sign-in', async () => {
    seed(fixtures.errorReadModel());
    render(<ConnectAgentModal id="modal-1" agent="codex" />);
    const status = document.querySelector('[data-cli-installed]');
    expect(status?.getAttribute('data-cli-installed')).toBe('false');
    expect(status?.textContent).toContain('codex is not installed.');
    expect(identity()).toBeNull();
    expect(screen.queryByRole('button', { name: /^Sign in with/ })).toBeNull();
    expect(screen.queryByRole('button', { name: copy.agentsPage.connect.verify })).toBeNull();
    await waitFor(() => expect(calls('agent.verify')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: copy.agentsPage.actions.installGuide }));
    await waitFor(() =>
      expect(calls('agent.installGuide')).toEqual([['agent.installGuide', { agent: 'codex' }]]),
    );
    pickedPath = '/opt/homebrew/bin/codex';
    fireEvent.click(screen.getByRole('button', { name: copy.agentsPage.actions.locate }));
    await waitFor(() =>
      expect(calls('detect.setBinary')).toEqual([
        ['detect.setBinary', { agent: 'codex', path: '/opt/homebrew/bin/codex' }],
      ]),
    );
    await waitFor(() => expect(calls('agent.verify')).toHaveLength(2));
    // Cancelling the picker changes nothing.
    pickedPath = null;
    fireEvent.click(screen.getByRole('button', { name: copy.agentsPage.actions.locate }));
    await waitFor(() => expect(calls('dialog.pickFile')).toHaveLength(2));
    expect(calls('detect.setBinary')).toHaveLength(1);
  });

  it('a refused Locate binary pick says why and remembers nothing; a retry that works clears it', async () => {
    seed(fixtures.errorReadModel());
    render(<ConnectAgentModal id="modal-1" agent="codex" />);
    await waitFor(() => expect(calls('agent.verify')).toHaveLength(1));
    pickedPath = '/Users/me/.codex/config.toml';
    setBinaryError = '/Users/me/.codex/config.toml did not run as Codex (no version reported). Pick the Codex executable itself.';
    fireEvent.click(screen.getByRole('button', { name: copy.agentsPage.actions.locate }));
    expect((await screen.findByRole('alert')).textContent).toBe(setBinaryError);
    expect(calls('agent.verify')).toHaveLength(1); // nothing to verify: the pick was refused
    setBinaryError = null;
    pickedPath = '/opt/homebrew/bin/codex';
    fireEvent.click(screen.getByRole('button', { name: copy.agentsPage.actions.locate }));
    await waitFor(() => expect(calls('agent.verify')).toHaveLength(2));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a located binary offers Forget binary → detect.clearBinary, then a verify', async () => {
    seed(
      withCli('gemini', {
        capabilities: {
          streamJson: true,
          source: 'manual',
          alternatives: [{ binary: '/Users/me/Downloads/gemini', version: '1.2.0', source: 'manual' }],
        },
      }),
    );
    render(<ConnectAgentModal id="modal-1" agent="gemini" />);
    await waitFor(() => expect(calls('agent.verify')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: copy.agentsPage.actions.forget }));
    await waitFor(() => expect(calls('detect.clearBinary')).toEqual([['detect.clearBinary', { agent: 'gemini' }]]));
    await waitFor(() => expect(calls('agent.verify')).toHaveLength(2));
    // A detected (not located) binary has no Forget action.
    cleanup();
    seed();
    render(<ConnectAgentModal id="modal-2" agent="gemini" />);
    expect(screen.queryByRole('button', { name: copy.agentsPage.actions.forget })).toBeNull();
  });

  it('shell needs no sign-in: just the note and Done, no verify', () => {
    render(<ConnectAgentModal id="modal-1" agent="shell" />);
    expect(screen.getByText(copy.agentsPage.connect.shell)).toBeTruthy();
    expect(document.querySelector('[data-cli-installed]')).toBeNull();
    expect(screen.queryByRole('button', { name: copy.agentsPage.connect.verify })).toBeNull();
    expect(calls('agent.verify')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: copy.agentsPage.connect.done }));
    expect(useUiStore.getState().overlays).toHaveLength(0);
  });

  it('Done closes; with returnTo on the overlay the Spawn modal comes back for that project, whoever pops it', () => {
    const returnTo = { modal: 'spawn' as const, projectId: acme };
    useUiStore.setState({
      overlays: [{ id: 'modal-1', kind: 'modal', modal: 'connect-agent', agent: 'gemini', returnTo }],
    });
    render(<ConnectAgentModal id="modal-1" agent="gemini" returnTo={returnTo} />);
    fireEvent.click(screen.getByRole('button', { name: copy.agentsPage.connect.done }));
    expect(useUiStore.getState().overlays).toMatchObject([
      { kind: 'modal', modal: 'spawn', projectId: acme },
    ]);
    cleanup();
    // Esc goes through the shell's close binding → store.popOverlay, never the component: the store honours returnTo.
    useUiStore.setState({
      overlays: [{ id: 'modal-2', kind: 'modal', modal: 'connect-agent', agent: 'gemini', returnTo }],
    });
    useUiStore.getState().popOverlay('modal-2');
    expect(useUiStore.getState().overlays).toMatchObject([
      { kind: 'modal', modal: 'spawn', projectId: acme },
    ]);
    cleanup();
    // Without returnTo the modal simply closes (Escape is handled by the registry, not the dialog).
    useUiStore.setState({
      overlays: [{ id: 'modal-3', kind: 'modal', modal: 'connect-agent', agent: 'gemini' }],
    });
    render(<ConnectAgentModal id="modal-3" agent="gemini" />);
    useUiStore.getState().popOverlay('modal-3');
    expect(useUiStore.getState().overlays).toHaveLength(0);
  });
});

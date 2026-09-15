// @vitest-environment jsdom
import { copy, fixtures } from '@styx/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { plainFolderReadModel } from '../../test-support/plain-folder';
import { SpawnModal } from './SpawnModal';

const acme = fixtures.ids.project.acmeShop;
const commandMock = vi.fn(async (name: string, _input?: unknown) => {
  if (name === 'session.spawn')
    return { ok: true as const, value: { sessionId: 'session-new', worktreeId: 'wt-new' } };
  if (name === 'dialog.pickFile') return { ok: true as const, value: { path: '/opt/homebrew/bin/codex' } };
  return { ok: true as const, value: {} };
});
const calls = (name: string) => commandMock.mock.calls.filter((c) => c[0] === name);

describe('SpawnModal', () => {
  beforeEach(() => {
    commandMock.mockClear();
    Object.assign(window, {
      styx: { platform: 'darwin', env: { now: fixtures.DEMO_NOW }, command: commandMock },
    });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({
      overlays: [{ id: 'modal-1', kind: 'modal', modal: 'spawn', projectId: acme }],
      screen: 'workspace',
      platform: 'darwin',
      projectId: acme,
      projectSession: {},
    });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('renders the header, five agent tiles with versions, and the project default agent chosen', () => {
    render(<SpawnModal id="modal-1" projectId={acme} />);
    expect(screen.getByRole('dialog').textContent).toContain('Spawn agent · acme-shop');
    const tiles = screen.getAllByRole('radio', { name: /Claude Code|Codex|Gemini CLI|Cursor agent|Shell/ });
    expect(tiles.map((t) => t.textContent)).toEqual([
      'Claude Codeclaude 2.4.1',
      'Codexcodex 0.9.3',
      'Gemini CLIgemini 1.2.0',
      'Cursor agentcursor-agent 0.5.2',
      'Shellzsh 5.9',
    ]);
    expect(tiles[0]?.getAttribute('data-inv')).toBe('true');
    expect(tiles[1]?.getAttribute('data-inv')).toBeNull();
    expect((screen.getByLabelText(copy.spawn.branch) as HTMLInputElement).value).toBe('agent/claude-1');
    expect((screen.getByLabelText(copy.spawn.worktree) as HTMLSelectElement).value).toBe('new');
    expect(screen.getByPlaceholderText('What should Claude Code do? Reference files with @.')).toBeTruthy();
    const boxes = screen.getAllByRole('checkbox').map((c) => (c as HTMLInputElement).checked);
    expect(boxes).toEqual([false, true, true]);
    expect(screen.getByRole('button', { name: 'Spawn · ⌘⏎' })).toBeTruthy();
  });

  it('plain folder (no git): the only worktree is the folder itself, New from main is disabled, Spawn sends the main worktree', async () => {
    const side = fixtures.ids.project.sideApi;
    useReadModel.getState().replaceModel(plainFolderReadModel(), 'connected');
    useUiStore.setState({
      projectId: side,
      overlays: [{ id: 'modal-1', kind: 'modal', modal: 'spawn', projectId: side }],
    });
    render(<SpawnModal id="modal-1" projectId={side} />);
    expect(document.querySelector('[data-spawn-modal]')?.getAttribute('data-plain-folder')).toBe('true');
    const select = screen.getByLabelText(copy.spawn.worktree) as HTMLSelectElement;
    expect(select.value).toBe(fixtures.ids.worktree.sideMain);
    const options = [...select.options].map((o) => [o.textContent, o.disabled]);
    expect(options).toEqual([
      [copy.spawn.worktreeFolder, false],
      [copy.spawn.worktreeDefault, true],
    ]);
    const branch = screen.getByLabelText(copy.spawn.branch) as HTMLInputElement;
    expect(branch.disabled).toBe(true);
    expect(branch.value).toBe('');
    expect(screen.getByRole('button', { name: 'Spawn · ⌘⏎' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Spawn · ⌘⏎' }));
    await waitFor(() => expect(calls('session.spawn')).toHaveLength(1));
    expect(calls('session.spawn')[0]?.[1]).toMatchObject({
      projectId: side,
      worktree: { kind: 'existing', worktreeId: fixtures.ids.worktree.sideMain },
    });
  });

  it('re-derives the branch when the agent changes unless the user edited it', () => {
    render(<SpawnModal id="modal-1" projectId={acme} />);
    const branch = screen.getByLabelText(copy.spawn.branch) as HTMLInputElement;
    fireEvent.click(screen.getByRole('radio', { name: /^Codex/ }));
    expect(branch.value).toBe('agent/codex-1');
    fireEvent.change(branch, { target: { value: 'feat/my-branch' } });
    fireEvent.click(screen.getByRole('radio', { name: /^Gemini/ }));
    expect(branch.value).toBe('feat/my-branch');
  });

  it('shows the inline error and disables Spawn when the chosen CLI is missing', async () => {
    useReadModel.getState().replaceModel(fixtures.errorReadModel(), 'connected');
    render(<SpawnModal id="modal-1" projectId={acme} />);
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /^Codex/ }));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Codex CLI not found on PATH.');
    expect(within(alert).getByRole('button', { name: copy.errors.cliMissing.cta })).toBeTruthy();
    // Locate binary: OS file picker (main) → detect.setBinary for the chosen agent.
    const locate = within(alert).getByRole('button', { name: copy.errors.locateBinary });
    expect(locate.hasAttribute('disabled')).toBe(false);
    fireEvent.click(locate);
    await waitFor(() => expect(calls('detect.setBinary')).toHaveLength(1));
    expect(calls('detect.setBinary')[0]?.[1]).toEqual({ agent: 'codex', path: '/opt/homebrew/bin/codex' });
    expect(screen.getByRole('button', { name: 'Spawn · ⌘⏎' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(alert).getByRole('button', { name: copy.errors.cliMissing.cta }));
    expect(useUiStore.getState().screen).toBe('onboarding');
    expect(useUiStore.getState().onboardingStep).toBe(3);
    expect(useUiStore.getState().overlays).toHaveLength(0);
  });

  it('a signed-out CLI warns without blocking; Fix connection swaps in the Connect agent modal that returns here', () => {
    render(<SpawnModal id="modal-1" projectId={acme} />);
    // The demo default (claude) is connected: no row at all, so the spawn baseline is untouched.
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /^Gemini/ }));
    const alert = screen.getByRole('alert');
    expect(alert.getAttribute('data-spawn-cli')).toBe('not-connected');
    expect(alert.textContent).toContain("Gemini CLI isn't connected.");
    expect(within(alert).queryByRole('button', { name: copy.errors.cliMissing.cta })).toBeNull();
    expect(within(alert).queryByRole('button', { name: copy.errors.locateBinary })).toBeNull();
    expect(screen.getByRole('button', { name: 'Spawn · ⌘⏎' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(within(alert).getByRole('button', { name: copy.errors.fixConnection }));
    expect(useUiStore.getState().overlays).toMatchObject([
      {
        kind: 'modal',
        modal: 'connect-agent',
        agent: 'gemini',
        returnTo: { modal: 'spawn', projectId: acme },
      },
    ]);
    expect(useUiStore.getState().overlays).toHaveLength(1);
  });

  it('a missing CLI keeps Install guide + Locate binary and gains Fix connection', () => {
    useReadModel.getState().replaceModel(fixtures.errorReadModel(), 'connected');
    render(<SpawnModal id="modal-1" projectId={acme} />);
    fireEvent.click(screen.getByRole('radio', { name: /^Codex/ }));
    const alert = screen.getByRole('alert');
    expect(alert.getAttribute('data-spawn-cli')).toBe('missing');
    expect(
      within(alert)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([copy.errors.cliMissing.cta, copy.errors.locateBinary, copy.errors.fixConnection]);
    fireEvent.click(within(alert).getByRole('button', { name: copy.errors.fixConnection }));
    expect(useUiStore.getState().overlays).toMatchObject([
      {
        kind: 'modal',
        modal: 'connect-agent',
        agent: 'codex',
        returnTo: { modal: 'spawn', projectId: acme },
      },
    ]);
  });

  it('Spawn sends session.spawn, closes and opens Workspace on the new session', async () => {
    render(<SpawnModal id="modal-1" projectId={acme} />);
    fireEvent.change(screen.getByLabelText(copy.spawn.firstMessage), { target: { value: 'Add validation' } });
    fireEvent.click(screen.getByRole('checkbox', { name: copy.spawn.toggles.autoApproveEdits }));
    fireEvent.click(screen.getByRole('button', { name: 'Spawn · ⌘⏎' }));
    await waitFor(() => expect(useUiStore.getState().overlays).toHaveLength(0));
    expect(commandMock).toHaveBeenCalledWith('session.spawn', {
      projectId: acme,
      agent: 'claude',
      worktree: { kind: 'new', base: 'main', branch: 'agent/claude-1' },
      firstMessage: 'Add validation',
      toggles: { autoApproveEdits: true, mayRequestTargets: true, notifyWhenNeedsMe: true },
      model: null,
      permissionMode: 'default',
      effort: null,
    });
    const ui = useUiStore.getState();
    expect(ui.screen).toBe('workspace');
    expect(ui.projectSession[acme]).toBe('session-new');
  });

  it('Claude tile shows Permissions / Model / Effort selects seeded from project defaults; picks ride along (discrepancy #54)', async () => {
    render(<SpawnModal id="modal-1" projectId={acme} />);
    const mode = screen.getByLabelText(copy.chat.controls.permissions) as HTMLSelectElement;
    expect(mode.value).toBe('default');
    expect(screen.getByText(copy.session.permissionModeHints.default)).toBeTruthy();
    fireEvent.change(mode, { target: { value: 'plan' } });
    expect(screen.getByText(copy.session.permissionModeHints.plan)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(copy.chat.controls.model), { target: { value: 'sonnet' } });
    fireEvent.change(screen.getByLabelText(copy.chat.controls.effort), { target: { value: 'max' } });
    fireEvent.click(screen.getByRole('button', { name: 'Spawn · ⌘⏎' }));
    await waitFor(() => expect(calls('session.spawn')).toHaveLength(1));
    expect(calls('session.spawn')[0]?.[1]).toMatchObject({
      permissionMode: 'plan',
      model: 'sonnet',
      effort: 'max',
    });
  });

  it('Cursor shows only Model; Codex shows no session settings and spawns with CLI defaults', async () => {
    render(<SpawnModal id="modal-1" projectId={acme} />);
    fireEvent.change(screen.getByLabelText(copy.chat.controls.model), { target: { value: 'opus' } });
    fireEvent.click(screen.getByRole('radio', { name: /^Cursor/ }));
    expect(screen.queryByLabelText(copy.chat.controls.permissions)).toBeNull();
    expect(screen.queryByLabelText(copy.chat.controls.effort)).toBeNull();
    expect((screen.getByLabelText(copy.chat.controls.model) as HTMLSelectElement).value).toBe('opus');
    fireEvent.click(screen.getByRole('radio', { name: /^Codex/ }));
    expect(document.querySelector('[data-spawn-settings]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Spawn · ⌘⏎' }));
    await waitFor(() => expect(calls('session.spawn')).toHaveLength(1));
    expect(calls('session.spawn')[0]?.[1]).toMatchObject({
      agent: 'codex',
      model: null,
      permissionMode: 'default',
      effort: null,
    });
  });

  it('an existing worktree sends its id and locks the branch field', async () => {
    render(<SpawnModal id="modal-1" projectId={acme} />);
    fireEvent.change(screen.getByLabelText(copy.spawn.worktree), {
      target: { value: fixtures.ids.worktree.fixCheckout },
    });
    const branch = screen.getByLabelText(copy.spawn.branch) as HTMLInputElement;
    expect(branch.value).toBe('fix/checkout');
    expect(branch.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Spawn · ⌘⏎' }));
    await waitFor(() => expect(commandMock).toHaveBeenCalled());
    expect(commandMock.mock.calls[0]?.[1]).toMatchObject({
      worktree: { kind: 'existing', worktreeId: fixtures.ids.worktree.fixCheckout },
    });
  });

  it('Mod+Enter submits from inside the form; Cancel closes without spawning', async () => {
    render(<SpawnModal id="modal-1" projectId={acme} />);
    fireEvent.keyDown(screen.getByLabelText(copy.spawn.firstMessage), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(commandMock).toHaveBeenCalledWith('session.spawn', expect.anything()));
    commandMock.mockClear();
    useUiStore.setState({ overlays: [{ id: 'modal-2', kind: 'modal', modal: 'spawn', projectId: acme }] });
    cleanup();
    render(<SpawnModal id="modal-2" projectId={acme} />);
    fireEvent.click(screen.getByRole('button', { name: copy.spawn.cancel }));
    expect(useUiStore.getState().overlays).toHaveLength(0);
    expect(commandMock).not.toHaveBeenCalled();
  });
});

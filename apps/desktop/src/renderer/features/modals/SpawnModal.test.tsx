// @vitest-environment jsdom
import { copy, fixtures } from '@styx/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { SpawnModal } from './SpawnModal';

const acme = fixtures.ids.project.acmeShop;
const commandMock = vi.fn(async (name: string, _input?: unknown) =>
  name === 'session.spawn'
    ? { ok: true as const, value: { sessionId: 'session-new', worktreeId: 'wt-new' } }
    : { ok: true as const, value: {} },
);

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

  it('re-derives the branch when the agent changes unless the user edited it', () => {
    render(<SpawnModal id="modal-1" projectId={acme} />);
    const branch = screen.getByLabelText(copy.spawn.branch) as HTMLInputElement;
    fireEvent.click(screen.getByRole('radio', { name: /^Codex/ }));
    expect(branch.value).toBe('agent/codex-1');
    fireEvent.change(branch, { target: { value: 'feat/my-branch' } });
    fireEvent.click(screen.getByRole('radio', { name: /^Gemini/ }));
    expect(branch.value).toBe('feat/my-branch');
  });

  it('shows the inline error and disables Spawn when the chosen CLI is missing', () => {
    useReadModel.getState().replaceModel(fixtures.errorReadModel(), 'connected');
    render(<SpawnModal id="modal-1" projectId={acme} />);
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /^Codex/ }));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Codex CLI not found on PATH.');
    expect(within(alert).getByRole('button', { name: copy.errors.cliMissing.cta })).toBeTruthy();
    // Enabled no-op until a file-picker command exists (prototype keeps it enabled).
    expect(
      within(alert).getByRole('button', { name: copy.errors.locateBinary }).hasAttribute('disabled'),
    ).toBe(false);
    expect(screen.getByRole('button', { name: 'Spawn · ⌘⏎' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(alert).getByRole('button', { name: copy.errors.cliMissing.cta }));
    expect(useUiStore.getState().screen).toBe('onboarding');
    expect(useUiStore.getState().onboardingStep).toBe(3);
    expect(useUiStore.getState().overlays).toHaveLength(0);
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
    });
    const ui = useUiStore.getState();
    expect(ui.screen).toBe('workspace');
    expect(ui.projectSession[acme]).toBe('session-new');
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

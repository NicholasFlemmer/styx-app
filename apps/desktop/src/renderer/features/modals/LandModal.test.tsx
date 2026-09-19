// @vitest-environment jsdom
import { copy, fixtures, type WorktreeId } from '@styx/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { filesLine, LandModal } from './LandModal';

const { ids } = fixtures;
const testFlaky = ids.worktree.testFlaky as WorktreeId;

/** Default answers: the preview and the draft resolve at once; landing succeeds with three steps and a push. */
const answer = async (name: string): Promise<unknown> => {
  if (name === 'worktree.landPreview')
    return {
      ok: true,
      value: {
        base: 'main',
        files: [
          { path: 'a.ts', added: 1, removed: 0 },
          { path: 'b.ts', added: 2, removed: 1 },
        ],
        willPush: true,
        remote: 'origin',
      },
    };
  if (name === 'worktree.generateMessage')
    return { ok: true, value: { title: 'Fix the flaky test', body: 'Waits for the mock.' } };
  if (name === 'worktree.land')
    return {
      ok: true,
      value: {
        commit: 'abcdef1234567890',
        pushed: true,
        steps: ['committed 1234567', 'checks passed', 'merged into main (abcdef1)', 'pushed main'],
      },
    };
  return { ok: true, value: {} };
};
const commandMock = vi.fn(answer);
const calls = (name: string) =>
  commandMock.mock.calls.filter((c) => (c as unknown[])[0] === name).map((c) => (c as unknown[])[1]);
const dialog = () => screen.getByRole('dialog');
const steps = () => [...document.querySelectorAll<HTMLElement>('[data-land-step]')];

describe('LandModal (ADR-0025 phase C)', () => {
  beforeEach(() => {
    commandMock.mockReset();
    commandMock.mockImplementation(answer);
    Object.assign(window, { styx: { platform: 'darwin', env: {}, command: commandMock } });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({
      overlays: [{ id: 'modal-1', kind: 'modal', modal: 'land', worktreeId: testFlaky }],
      platform: 'darwin',
      projectId: ids.project.acmeShop,
    });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('filesLine: singular and plural', () => {
    expect(filesLine(1)).toBe('1 file changed');
    expect(filesLine(3)).toBe('3 files changed');
  });

  it('shows the preview (files, where the base goes) and the drafted summary; the lead names the agent and the base', async () => {
    render(<LandModal id="modal-1" worktreeId={testFlaky} />);
    expect(screen.getByRole('dialog', { name: 'Land test/flaky into main' })).toBeTruthy();
    expect(within(dialog()).getByText(/drafted by Claude Code/)).toBeTruthy();
    await waitFor(() => expect(within(dialog()).getByText('2 files changed')).toBeTruthy());
    expect(within(dialog()).getByText('Then main is pushed to origin.')).toBeTruthy();
    const message = within(dialog()).getByLabelText(copy.land.messageLabel) as HTMLTextAreaElement;
    await waitFor(() => expect(message.value).toBe('Fix the flaky test\n\nWaits for the mock.'));
    expect(calls('worktree.landPreview')).toEqual([{ worktreeId: testFlaky }]);
    expect(calls('worktree.generateMessage')).toEqual([{ worktreeId: testFlaky, kind: 'commit' }]);
  });

  it('Land runs one worktree.land with the edited summary, lists the steps, and ends on Close', async () => {
    render(<LandModal id="modal-1" worktreeId={testFlaky} />);
    const message = within(dialog()).getByLabelText(copy.land.messageLabel) as HTMLTextAreaElement;
    await waitFor(() => expect(message.value).not.toBe(''));
    fireEvent.change(message, { target: { value: 'Flaky test fixed\n\nBy hand.' } });
    fireEvent.click(screen.getByRole('button', { name: copy.land.run }));
    await waitFor(() => expect(steps().at(-1)?.getAttribute('data-state')).toBe('done'));
    expect(calls('worktree.land')).toEqual([
      { worktreeId: testFlaky, message: { title: 'Flaky test fixed', body: 'By hand.' } },
    ]);
    expect(steps().map((s) => s.textContent)).toEqual([
      'committed 1234567',
      'checks passed',
      'merged into main (abcdef1)',
      'pushed main',
      'test/flaky is now in main and on origin.',
    ]);
    expect(within(dialog()).queryByLabelText(copy.land.messageLabel)).toBeNull();
    fireEvent.click(document.querySelector('[data-land-close]') as HTMLElement);
    expect(useUiStore.getState().overlays).toHaveLength(0);
  });

  it('a refused landing reads as one failed line, and Land stays off without a summary', async () => {
    commandMock.mockImplementation(async (name: string) =>
      name === 'worktree.land'
        ? {
            ok: false,
            error: {
              code: 'invalid-input',
              message: 'The main folder has uncommitted changes on main. Commit or discard them first.',
            },
          }
        : name === 'worktree.generateMessage'
          ? { ok: false, error: { code: 'internal', message: 'claude timed out' } }
          : answer(name),
    );
    render(<LandModal id="modal-1" worktreeId={testFlaky} />);
    await waitFor(() => expect(within(dialog()).getByText(/Could not draft a message/)).toBeTruthy());
    const run = screen.getByRole('button', { name: copy.land.run }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    fireEvent.change(within(dialog()).getByLabelText(copy.land.messageLabel), { target: { value: 'Mine' } });
    expect(run.disabled).toBe(false);
    fireEvent.click(run);
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'Not landed: The main folder has uncommitted changes on main. Commit or discard them first.',
      ),
    );
  });
});

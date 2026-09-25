// @vitest-environment jsdom
import { fixtures, type ReadModel } from '@styx/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { UpdateModal, useUpdatePrompt } from './UpdateModal';

const commandMock = vi.fn(async () => ({ ok: true, value: {} }));

const withUpdate = (update: Partial<ReadModel['update']>, idle = true): ReadModel => {
  const m = fixtures.demoReadModel();
  const byId = idle
    ? Object.fromEntries(
        Object.entries(m.sessions.byId).map(([k, s]) => [k, { ...s, state: 'idle' as const }]),
      )
    : m.sessions.byId;
  return { ...m, sessions: { ...m.sessions, byId }, update: { ...m.update, current: '0.2.0', ...update } };
};

function Prompter() {
  useUpdatePrompt();
  return null;
}

describe('UpdateModal (#119)', () => {
  beforeEach(() => {
    commandMock.mockClear();
    Object.assign(window, { styx: { platform: 'darwin', env: {}, command: commandMock } });
    useUiStore.setState({ overlays: [], platform: 'darwin' });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('opens as soon as an update is found, once per version', () => {
    useReadModel.getState().replaceModel(withUpdate({ status: 'idle' }), 'connected');
    const { rerender } = render(<Prompter />);
    expect(useUiStore.getState().overlays).toEqual([]);
    act(() =>
      useReadModel
        .getState()
        .replaceModel(withUpdate({ status: 'downloading', next: '0.2.1', percent: 3 }), 'connected'),
    );
    rerender(<Prompter />);
    expect(useUiStore.getState().overlays).toMatchObject([{ kind: 'modal', modal: 'update' }]);
    act(() => useUiStore.setState({ overlays: [] }));
    act(() =>
      useReadModel
        .getState()
        .replaceModel(withUpdate({ status: 'ready', next: '0.2.1', percent: 100 }), 'connected'),
    );
    rerender(<Prompter />);
    expect(useUiStore.getState().overlays).toEqual([]);
  });

  it('while downloading: "Update available", progress, Restart disabled', () => {
    useReadModel
      .getState()
      .replaceModel(withUpdate({ status: 'downloading', next: '0.2.1', percent: 42 }), 'connected');
    useUiStore.setState({ overlays: [{ id: 'm1', kind: 'modal', modal: 'update' }] });
    render(<UpdateModal id="m1" />);
    expect(screen.getByRole('dialog', { name: 'Update available: Styx 0.2.1' })).toBeTruthy();
    expect(document.querySelector('[data-update-phase]')?.textContent).toContain('42%');
    expect((screen.getByRole('button', { name: 'Restart to update' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('Restart to update installs; Later closes; agents at work are named', () => {
    useReadModel
      .getState()
      .replaceModel(withUpdate({ status: 'ready', next: '0.2.1', percent: 100 }, false), 'connected');
    useUiStore.setState({ overlays: [{ id: 'm1', kind: 'modal', modal: 'update' }] });
    render(<UpdateModal id="m1" />);
    expect(screen.getByRole('dialog', { name: 'Styx 0.2.1 is ready' })).toBeTruthy();
    expect(document.querySelector('[data-update-modal]')?.textContent).toMatch(/agents are working/);
    fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }));
    expect(commandMock).toHaveBeenCalledWith('update.install', {});
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(useUiStore.getState().overlays).toEqual([]);
  });
});

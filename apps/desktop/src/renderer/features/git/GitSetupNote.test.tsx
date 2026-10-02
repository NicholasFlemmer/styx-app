// @vitest-environment jsdom
import { copy, fill, fixtures } from '@styx/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitSetupNote } from './GitSetupNote';

const listeners = new Map<string, Set<(payload: unknown) => void>>();
const emit = (name: string, payload: unknown) =>
  act(() => {
    for (const cb of listeners.get(name) ?? []) cb(payload);
  });

let installed = false;
let installCommand: string | null = 'xcode-select --install';
const commandMock = vi.fn(async (name: string, _input?: unknown) => {
  switch (name) {
    case 'git.status':
      return {
        ok: true as const,
        value: { installed, version: installed ? '2.47.0' : null, installCommand },
      };
    case 'git.install':
      return {
        ok: true as const,
        value:
          installCommand === null
            ? { terminalId: null, command: null }
            : { terminalId: 't1', command: installCommand },
      };
    default:
      return { ok: true as const, value: {} };
  }
});
const calls = (name: string) => commandMock.mock.calls.filter((c) => c[0] === name);

describe('GitSetupNote', () => {
  beforeEach(() => {
    vi.useRealTimers();
    commandMock.mockClear();
    listeners.clear();
    installed = false;
    installCommand = 'xcode-select --install';
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
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('says nothing while git is installed', async () => {
    installed = true;
    const { container } = render(<GitSetupNote />);
    await waitFor(() => expect(calls('git.status')).toHaveLength(1));
    expect(container.innerHTML).toBe('');
  });

  it('missing: one button runs the installer, then it checks until git is there and says it is ready', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onReady = vi.fn();
    render(<GitSetupNote onReady={onReady} />);
    expect(await screen.findByText(copy.gitSetup.missing)).toBeTruthy();
    expect(screen.getByText(fill(copy.gitSetup.runs, { command: 'xcode-select --install' }))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: copy.gitSetup.install }));
    expect(await screen.findByText(copy.gitSetup.installing)).toBeTruthy();
    expect(calls('git.install')[0]?.[1]).toEqual({ download: false });
    // Apple's dialog: the command exits 0 at once; the note keeps checking.
    emit('git.install', { terminalId: 't1', status: 'exited', exitCode: 0 });
    expect(screen.getByText(copy.gitSetup.installing)).toBeTruthy();
    installed = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(await screen.findByText(copy.gitSetup.ready)).toBeTruthy();
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('a stopped installer offers the download page; with no installer here, the button is Download from the start', async () => {
    render(<GitSetupNote />);
    fireEvent.click(await screen.findByRole('button', { name: copy.gitSetup.install }));
    await screen.findByText(copy.gitSetup.installing);
    emit('git.install', { terminalId: 'other', status: 'exited', exitCode: 1 });
    expect(screen.getByText(copy.gitSetup.installing)).toBeTruthy();
    emit('git.install', { terminalId: 't1', status: 'exited', exitCode: 1 });
    expect(screen.getByText(fill(copy.gitSetup.failed, { code: 1 }))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: copy.gitSetup.download }));
    await waitFor(() => expect(calls('git.install').at(-1)?.[1]).toEqual({ download: true }));
    cleanup();

    installCommand = null;
    render(<GitSetupNote text={copy.gitSetup.cloneNeedsGit} />);
    expect(await screen.findByText(copy.gitSetup.cloneNeedsGit)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: copy.gitSetup.download }));
    await waitFor(() => expect(calls('git.install').at(-1)?.[1]).toEqual({ download: true }));
  });
});

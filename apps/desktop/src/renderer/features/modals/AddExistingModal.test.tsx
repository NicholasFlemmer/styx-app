// @vitest-environment jsdom
import { copy, fixtures } from '@styx/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { AddExistingModal } from './AddExistingModal';

const repo = (path: string, suggested: boolean, extra: Record<string, unknown> = {}) => ({
  path,
  source: 'scan',
  hasGit: true,
  remote: 'git@github.com:acme/x.git',
  branch: 'main',
  lastModifiedAt: fixtures.DEMO_NOW - 60_000,
  suggested,
  ...extra,
});
let scanned: unknown[] = [
  repo('/Users/me/code/shop', true),
  repo('/Users/me/code/old', false, { remote: null, lastModifiedAt: fixtures.DEMO_NOW - 400 * 24 * 3600e3 }),
  repo('/Users/me/notes', true, { source: 'ide-recent', hasGit: false, remote: null, branch: null }),
];
let scanOk = true;
const commandMock = vi.fn<(name: string, input?: unknown) => Promise<unknown>>(async (name, input) => {
  if (name === 'project.scan')
    return scanOk
      ? { ok: true as const, value: { repos: scanned } }
      : { ok: false as const, error: { code: 'io', message: 'walk failed' } };
  if (name === 'project.add')
    return { ok: true as const, value: { projectId: `p:${(input as { path: string }).path}` } };
  if (name === 'dialog.pickFolder') return { ok: true as const, value: { path: '/Users/me/picked' } };
  return { ok: true as const, value: {} };
});
const calls = (name: string) => commandMock.mock.calls.filter((c) => c[0] === name);

describe('AddExistingModal', () => {
  beforeEach(() => {
    commandMock.mockClear();
    scanOk = true;
    Object.assign(window, {
      styx: { platform: 'darwin', env: { now: fixtures.DEMO_NOW }, command: commandMock },
    });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({
      overlays: [{ id: 'modal-1', kind: 'modal', modal: 'add-existing' }],
      screen: 'home',
      platform: 'darwin',
      projectId: null,
    });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('scans on open (recents included), lists rows with onboarding meta, suggested rows pre-checked', async () => {
    render(<AddExistingModal id="modal-1" />);
    expect(screen.getByRole('status').textContent).toBe(copy.addExisting.scanning);
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3));
    expect(calls('project.scan').map((c) => c[1])).toEqual([{ includeIdeRecents: true }]);
    const rows = screen.getAllByRole('row');
    expect(rows.map((r) => within(r).getAllByRole('cell')[2]?.textContent)).toEqual([
      'github · main',
      'no remote · 1y old',
      copy.workspace.noGit,
    ]);
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.map((b) => (b as HTMLInputElement).checked)).toEqual([true, false, true]);
    expect(screen.getByRole('button', { name: 'Add 2' })).toBeTruthy();
  });

  it('Add n adds every checked row, closes, and enters the project only when exactly one was added', async () => {
    render(<AddExistingModal id="modal-1" />);
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3));
    fireEvent.click(screen.getByRole('button', { name: 'Add 2' }));
    await waitFor(() => expect(useUiStore.getState().overlays).toHaveLength(0));
    expect(calls('project.add').map((c) => c[1])).toEqual([
      { path: '/Users/me/code/shop' },
      { path: '/Users/me/notes' },
    ]);
    // Two added: stay put (Home lists them), no project selected.
    expect(useUiStore.getState().screen).toBe('home');
    expect(calls('project.select')).toHaveLength(0);
  });

  it('a single added project lands in its Workspace; unchecking everything disables Add', async () => {
    render(<AddExistingModal id="modal-1" />);
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3));
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[2] as HTMLElement);
    expect(screen.getByRole('button', { name: 'Add 1' })).toBeTruthy();
    fireEvent.click(boxes[0] as HTMLElement);
    expect((screen.getByRole('button', { name: copy.addExisting.addNone }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(boxes[1] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Add 1' }));
    await waitFor(() => expect(useUiStore.getState().screen).toBe('workspace'));
    expect(useUiStore.getState().projectId).toBe('p:/Users/me/code/old');
    expect(calls('project.select').map((c) => c[1])).toEqual([{ projectId: 'p:/Users/me/code/old' }]);
  });

  it('empty scan shows the empty note with Rescan; a failed scan shows the message', async () => {
    scanned = [];
    render(<AddExistingModal id="modal-1" />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(copy.addExisting.empty));
    scanned = [repo('/Users/me/code/shop', true)];
    fireEvent.click(screen.getByRole('button', { name: copy.addExisting.rescan }));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(1));
    expect(calls('project.scan')).toHaveLength(2);
    cleanup();
    scanOk = false;
    render(<AddExistingModal id="modal-1" />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Scan failed: walk failed'));
  });

  it('Open folder… closes the modal and runs the picker → project.add → Workspace', async () => {
    render(<AddExistingModal id="modal-1" />);
    fireEvent.click(screen.getByRole('button', { name: copy.addExisting.openFolder }));
    await waitFor(() => expect(useUiStore.getState().screen).toBe('workspace'));
    expect(useUiStore.getState().overlays).toHaveLength(0);
    expect(calls('project.add').map((c) => c[1])).toEqual([{ path: '/Users/me/picked' }]);
  });

  it('Cancel closes without adding', async () => {
    render(<AddExistingModal id="modal-1" />);
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: copy.general.cancel }));
    expect(useUiStore.getState().overlays).toHaveLength(0);
    expect(calls('project.add')).toHaveLength(0);
  });
});

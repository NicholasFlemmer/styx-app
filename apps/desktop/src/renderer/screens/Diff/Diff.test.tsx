// @vitest-environment jsdom
import { copy, fixtures, type ProjectId, type SessionId } from '@styx/core';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keys } from '../../keys';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { plainFolderReadModel } from '../../test-support/plain-folder';
import { Diff } from './Diff';

const acme = fixtures.ids.project.acmeShop as ProjectId;
const claude = fixtures.ids.session.claude as SessionId;
const hunkId = (n: number) => fixtures.ids.hunk(n);
const commandMock = vi.fn(async () => ({ ok: true as const, value: { applied: 0 } }));

const route = (e: KeyboardEvent) => {
  keys.dispatch(e);
};
const press = (init: KeyboardEventInit) => {
  const target = document.activeElement ?? document.body;
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
};
const hunk = (n: number) => {
  const el = document.querySelector<HTMLElement>(`[data-hunk="${hunkId(n)}"]`);
  if (el === null) throw new Error(`no hunk ${n}`);
  return el;
};

describe('Diff review screen', () => {
  beforeEach(() => {
    commandMock.mockClear();
    Object.assign(window, { styx: { platform: 'darwin', env: { now: fixtures.DEMO_NOW }, command: commandMock } });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({
      overlays: [],
      screen: 'diff',
      platform: 'darwin',
      projectId: acme,
      projectSession: {},
      diffFocusIndex: 0,
    });
    document.addEventListener('keydown', route, true);
  });
  afterEach(() => {
    document.removeEventListener('keydown', route, true);
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('renders header meta, files with +N counts, the Keys legend, and every hunk', () => {
    render(<Diff />);
    expect(screen.getByText(copy.diff.title)).toBeTruthy();
    expect(screen.getByText('Claude · fix/checkout · 0 accepted · 0 rejected · 3 pending')).toBeTruthy();
    expect(screen.getByText('Files · 2')).toBeTruthy();
    expect(within(document.querySelector('[data-file="checkout.ts"]') as HTMLElement).getByText('+2')).toBeTruthy();
    const legend = document.querySelector('[data-diff-keys]')?.textContent ?? '';
    expect(legend).toContain(copy.diff.keys.acceptReject);
    expect(legend).toContain(copy.diff.keys.nextPrev);
    expect(legend).toContain('⌘⏎ done');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    const first = within(hunk(1));
    expect(first.getByText('@@ -1,2 +1,3 @@')).toBeTruthy();
    expect(first.getByText('pending')).toBeTruthy();
    expect(first.getByText('+ import { validate } from "./validate"').getAttribute('data-kind')).toBe('add');
    // The screen owns focus so plain keys resolve in scope `diff`; no hunk is marked yet.
    expect(document.activeElement?.getAttribute('data-keyscope')).toBe('diff');
  });

  it('Accept / Reject buttons and the header actions dispatch hunk commands', () => {
    render(<Diff />);
    fireEvent.click(within(hunk(1)).getByRole('button', { name: copy.diff.accept }));
    expect(commandMock).toHaveBeenCalledWith('hunk.accept', { hunkId: hunkId(1) });
    fireEvent.click(within(hunk(2)).getByRole('button', { name: copy.diff.reject }));
    expect(commandMock).toHaveBeenCalledWith('hunk.reject', { hunkId: hunkId(2) });
    fireEvent.click(screen.getByRole('button', { name: copy.diff.acceptAll }));
    expect(commandMock).toHaveBeenCalledWith('hunk.acceptAll', { sessionId: claude });
    fireEvent.click(screen.getByRole('button', { name: copy.diff.rejectAll }));
    expect(commandMock).toHaveBeenCalledWith('hunk.rejectAll', { sessionId: claude });
  });

  it('reflects statuses from the model: accepted → tag on + Accept inverted; rejected → Reject inverted', () => {
    const model = fixtures.demoReadModel();
    const hunks = (model.hunks[claude] ?? []).map((h, i) =>
      i === 0 ? { ...h, status: 'accepted' as const } : i === 1 ? { ...h, status: 'rejected' as const } : h,
    );
    useReadModel.getState().replaceModel({ ...model, hunks: { ...model.hunks, [claude]: hunks } }, 'connected');
    render(<Diff />);
    expect(screen.getByText('Claude · fix/checkout · 1 accepted · 1 rejected · 1 pending')).toBeTruthy();
    const first = within(hunk(1));
    expect(first.getByText('accepted').getAttribute('data-on')).toBe('true');
    expect(first.getByRole('button', { name: copy.diff.accept }).getAttribute('data-inv')).toBe('true');
    expect(first.getByRole('button', { name: copy.diff.reject }).getAttribute('data-inv')).toBeNull();
    const second = within(hunk(2));
    expect(second.getByText('rejected').getAttribute('data-on')).toBeNull();
    expect(second.getByRole('button', { name: copy.diff.reject }).getAttribute('data-inv')).toBe('true');
  });

  it('j / k move the focused hunk, a / r decide it, Mod+Enter finishes', async () => {
    render(<Diff />);
    act(() => press({ key: 'j' }));
    expect(useUiStore.getState().diffFocusIndex).toBe(1);
    expect(document.activeElement).toBe(hunk(2));
    act(() => press({ key: 'j' }));
    act(() => press({ key: 'j' }));
    expect(useUiStore.getState().diffFocusIndex).toBe(2);
    act(() => press({ key: 'a' }));
    expect(commandMock).toHaveBeenCalledWith('hunk.accept', { hunkId: hunkId(3) });
    act(() => press({ key: 'k' }));
    expect(document.activeElement).toBe(hunk(2));
    act(() => press({ key: 'r' }));
    expect(commandMock).toHaveBeenCalledWith('hunk.reject', { hunkId: hunkId(2) });
    act(() => press({ key: 'Enter', metaKey: true }));
    expect(commandMock).toHaveBeenCalledWith('hunk.done', { sessionId: claude });
    await waitFor(() => expect(useUiStore.getState().screen).toBe('workspace'));
  });

  it('Done applies accepted hunks then returns to Workspace only when main succeeds', async () => {
    commandMock.mockImplementationOnce(async () => ({ ok: false, error: { code: 'internal', message: 'x' } }) as never);
    render(<Diff />);
    fireEvent.click(screen.getByRole('button', { name: copy.diff.done }));
    expect(commandMock).toHaveBeenCalledWith('hunk.done', { sessionId: claude });
    await Promise.resolve();
    expect(useUiStore.getState().screen).toBe('diff');
    fireEvent.click(screen.getByRole('button', { name: copy.diff.done }));
    await waitFor(() => expect(useUiStore.getState().screen).toBe('workspace'));
  });

  it('clicking inside a hunk makes it the focused one for a / r', () => {
    render(<Diff />);
    act(() => hunk(3).focus());
    expect(useUiStore.getState().diffFocusIndex).toBe(2);
  });

  it('a plain folder (no git) shows the empty state with `Initialise git` → project.gitInit; Done returns to Workspace', () => {
    const side = fixtures.ids.project.sideApi as ProjectId;
    useReadModel.getState().replaceModel(plainFolderReadModel(), 'connected');
    useUiStore.setState({ projectId: side });
    render(<Diff />);
    expect(document.querySelector('[data-diff-empty]')?.getAttribute('data-diff-empty')).toBe('no-git');
    expect(screen.getByText(copy.diff.title)).toBeTruthy();
    expect(document.querySelector('[data-diff-meta]')?.textContent).toBe(copy.workspace.noGit);
    expect(screen.getByText(copy.repo.noGit.label)).toBeTruthy();
    expect(screen.getByText(copy.repo.noGit.body)).toBeTruthy();
    expect(screen.queryByRole('list', { name: copy.diff.title })).toBeNull();
    expect(screen.queryByRole('button', { name: copy.diff.acceptAll })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: copy.repo.noGit.cta }));
    expect(commandMock).toHaveBeenCalledWith('project.gitInit', { projectId: side });
    fireEvent.click(screen.getByRole('button', { name: copy.diff.done }));
    expect(useUiStore.getState().screen).toBe('workspace');
  });
});

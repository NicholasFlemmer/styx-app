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
const commandMock = vi.fn(async () => ({ ok: true as const, value: { reviewed: 0 } }));

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
/** Each Revert names its hunk (`Revert · checkout.ts @@ …`) so screen readers can tell them apart. */
const revertButton = (n: number) =>
  within(hunk(n)).getByRole('button', { name: new RegExp(`^${copy.diff.revert} · `) });

/** Demo model with hunk 1 reviewed (`accepted`) and hunk 2 reverted (`rejected`); hunk 3 stays applied. */
const decidedModel = () => {
  const model = fixtures.demoReadModel();
  const hunks = (model.hunks[claude] ?? []).map((h, i) =>
    i === 0 ? { ...h, status: 'accepted' as const } : i === 1 ? { ...h, status: 'rejected' as const } : h,
  );
  return { ...model, hunks: { ...model.hunks, [claude]: hunks } };
};

describe('Diff review screen', () => {
  beforeEach(() => {
    commandMock.mockClear();
    Object.assign(window, {
      styx: { platform: 'darwin', env: { now: fixtures.DEMO_NOW }, command: commandMock },
    });
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

  it('renders header meta, files with +N counts, the Keys legend, and every hunk as applied', () => {
    render(<Diff />);
    expect(screen.getByText(copy.diff.title)).toBeTruthy();
    expect(screen.getByText('Claude · fix/checkout · 3 changes · 0 reverted · 0 reviewed')).toBeTruthy();
    expect(screen.getByText('Files · 2')).toBeTruthy();
    expect(
      within(document.querySelector('[data-file="checkout.ts"]') as HTMLElement).getByText('+2'),
    ).toBeTruthy();
    const legend = document.querySelector('[data-diff-keys]')?.textContent ?? '';
    expect(legend).toContain(copy.diff.keys.revert);
    expect(legend).toContain(copy.diff.keys.nextPrev);
    expect(legend).toContain('⌘⏎ done');
    expect(legend).not.toContain('a accept');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    const first = within(hunk(1));
    expect(first.getByText('@@ -1,2 +1,3 @@')).toBeTruthy();
    expect(first.getByText(copy.diff.status.pending)).toBeTruthy();
    expect(first.getByText('+ import { validate } from "./validate"').getAttribute('data-kind')).toBe('add');
    // One verb per hunk: Revert, enabled while applied. Nothing "accepts".
    expect(first.getAllByRole('button')).toHaveLength(1);
    expect(revertButton(1)?.getAttribute('aria-disabled')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Accept all' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject all' })).toBeNull();
    // The screen owns focus so plain keys resolve in scope `diff`; no hunk is marked yet.
    expect(document.activeElement?.getAttribute('data-keyscope')).toBe('diff');
  });

  it('Revert per hunk and Revert all in the header dispatch hunk.revert / hunk.revertAll', () => {
    render(<Diff />);
    fireEvent.click(revertButton(1));
    expect(commandMock).toHaveBeenCalledWith('hunk.revert', { hunkId: hunkId(1) });
    fireEvent.click(screen.getByRole('button', { name: copy.diff.revertAll }));
    expect(commandMock).toHaveBeenCalledWith('hunk.revertAll', { sessionId: claude });
    expect(commandMock).toHaveBeenCalledTimes(2);
  });

  it('reflects statuses from the model: reverted → tag on + Revert inverted; reviewed → tag plain; both disabled', () => {
    useReadModel.getState().replaceModel(decidedModel(), 'connected');
    render(<Diff />);
    expect(screen.getByText('Claude · fix/checkout · 3 changes · 1 reverted · 1 reviewed')).toBeTruthy();
    const first = within(hunk(1));
    expect(first.getByText(copy.diff.status.accepted).getAttribute('data-on')).toBeNull();
    expect(revertButton(1).getAttribute('data-inv')).toBeNull();
    expect(revertButton(1)?.getAttribute('aria-disabled')).toBe('true');
    const second = within(hunk(2));
    expect(second.getByText(copy.diff.status.rejected).getAttribute('data-on')).toBe('true');
    expect(revertButton(2).getAttribute('data-inv')).toBe('true');
    expect(revertButton(2)?.getAttribute('aria-disabled')).toBe('true');
    expect(within(hunk(3)).getByText(copy.diff.status.pending)).toBeTruthy();
    expect(revertButton(3)?.getAttribute('aria-disabled')).toBeNull();
    // A disabled Revert never dispatches.
    fireEvent.click(revertButton(1));
    fireEvent.click(revertButton(2));
    expect(commandMock).not.toHaveBeenCalled();
  });

  it('j / k move the focused hunk, r reverts it, a does nothing, Mod+Enter finishes', async () => {
    render(<Diff />);
    act(() => press({ key: 'j' }));
    expect(useUiStore.getState().diffFocusIndex).toBe(1);
    expect(document.activeElement).toBe(hunk(2));
    act(() => press({ key: 'j' }));
    act(() => press({ key: 'j' }));
    expect(useUiStore.getState().diffFocusIndex).toBe(2);
    act(() => press({ key: 'a' }));
    expect(commandMock).not.toHaveBeenCalled();
    act(() => press({ key: 'r' }));
    expect(commandMock).toHaveBeenCalledWith('hunk.revert', { hunkId: hunkId(3) });
    act(() => press({ key: 'k' }));
    expect(document.activeElement).toBe(hunk(2));
    act(() => press({ key: 'r' }));
    expect(commandMock).toHaveBeenCalledWith('hunk.revert', { hunkId: hunkId(2) });
    act(() => press({ key: 'Enter', metaKey: true }));
    expect(commandMock).toHaveBeenCalledWith('hunk.done', { sessionId: claude });
    await waitFor(() => expect(useUiStore.getState().screen).toBe('workspace'));
  });

  it('r on a hunk that is already reverted or reviewed dispatches nothing', () => {
    useReadModel.getState().replaceModel(decidedModel(), 'connected');
    render(<Diff />);
    act(() => press({ key: 'r' })); // hunk 1: reviewed
    act(() => press({ key: 'j' }));
    act(() => press({ key: 'r' })); // hunk 2: reverted
    expect(commandMock).not.toHaveBeenCalled();
    act(() => press({ key: 'j' }));
    act(() => press({ key: 'r' })); // hunk 3: applied
    expect(commandMock).toHaveBeenCalledWith('hunk.revert', { hunkId: hunkId(3) });
  });

  it('Done marks the pending hunks reviewed (hunk.done) then returns to Workspace only when main succeeds', async () => {
    commandMock.mockImplementationOnce(
      async () => ({ ok: false, error: { code: 'internal', message: 'x' } }) as never,
    );
    render(<Diff />);
    fireEvent.click(screen.getByRole('button', { name: copy.diff.done }));
    expect(commandMock).toHaveBeenCalledWith('hunk.done', { sessionId: claude });
    await Promise.resolve();
    expect(useUiStore.getState().screen).toBe('diff');
    fireEvent.click(screen.getByRole('button', { name: copy.diff.done }));
    await waitFor(() => expect(useUiStore.getState().screen).toBe('workspace'));
    expect(commandMock).toHaveBeenCalledTimes(2);
  });

  it('clicking inside a hunk makes it the focused one for r', () => {
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
    expect(screen.queryByRole('button', { name: copy.diff.revertAll })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: copy.repo.noGit.cta }));
    expect(commandMock).toHaveBeenCalledWith('project.gitInit', { projectId: side });
    fireEvent.click(screen.getByRole('button', { name: copy.diff.done }));
    expect(useUiStore.getState().screen).toBe('workspace');
  });
});

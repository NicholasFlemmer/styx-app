// @vitest-environment jsdom
import { copy, fixtures, type ProjectId, type SessionId } from '@styx/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { plainFolderReadModel } from '../../test-support/plain-folder';
import { Workspace } from './Workspace';

// Monaco and xterm need a real DOM/canvas; the screen's wiring is what is under test.
vi.mock('../../features/editor/MonacoEditor', () => ({
  MonacoEditor: ({ path, worktreeId }: { path: string | null; worktreeId: string }) => (
    <div data-testid="monaco" data-path={path ?? ''} data-worktree={worktreeId} />
  ),
  WORD_WRAP_KEY: 'editor.wordWrap',
  applyWordWrap: () => undefined,
}));
vi.mock('../../features/terminal/TerminalPane', () => ({
  TerminalPane: ({
    sessionId,
    worktreeId,
    branch,
  }: {
    sessionId: string | null;
    worktreeId: string;
    branch: string;
  }) => (
    <div
      data-testid="terminal"
      data-session={sessionId ?? ''}
      data-worktree={worktreeId}
      data-branch={branch}
    />
  ),
}));

const side = fixtures.ids.project.sideApi as ProjectId;
const sideMain = fixtures.ids.worktree.sideMain;
const acme = fixtures.ids.project.acmeShop as ProjectId;
const claude = fixtures.ids.session.claude as SessionId;

const listDir = (path: string) =>
  path === ''
    ? {
        entries: [
          { name: 'src', kind: 'dir', gitStatus: null },
          { name: 'README.md', kind: 'file', gitStatus: null },
        ],
      }
    : path === 'src'
      ? { entries: [{ name: 'server.ts', kind: 'file', gitStatus: null }] }
      : { entries: [] };
const commandMock = vi.fn(async (name: string, input?: unknown) => {
  if (name === 'fs.listDir') return { ok: true as const, value: listDir((input as { path: string }).path) };
  if (name === 'fs.readFile') return { ok: true as const, value: { text: '', eol: 'lf' } };
  return { ok: true as const, value: {} };
});

describe('Workspace screen', () => {
  beforeEach(() => {
    commandMock.mockClear();
    Object.assign(window, {
      styx: { platform: 'darwin', env: { now: fixtures.DEMO_NOW }, command: commandMock },
    });
    useUiStore.setState({
      overlays: [],
      screen: 'workspace',
      platform: 'darwin',
      projectId: side,
      projectSession: {},
      editorFile: null,
    });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('a project with no sessions falls back to its main worktree: files listed, editor + terminal bound, branch shown', async () => {
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected'); // side-api has no sessions
    render(<Workspace />);
    await waitFor(() => expect(screen.getByRole('treeitem', { name: 'README.md' })).toBeTruthy());
    expect(screen.getByRole('treeitem', { name: 'src/' })).toBeTruthy();
    expect(screen.getByRole('treeitem', { name: 'server.ts' })).toBeTruthy();
    expect(commandMock).toHaveBeenCalledWith('fs.listDir', { worktreeId: sideMain, path: '' });
    expect(screen.getByTestId('monaco').getAttribute('data-worktree')).toBe(sideMain);
    const terminal = screen.getByTestId('terminal');
    expect(terminal.getAttribute('data-session')).toBe(''); // no session yet: the terminal belongs to the worktree
    expect(terminal.getAttribute('data-worktree')).toBe(sideMain);
    expect(terminal.getAttribute('data-branch')).toBe('main');
    const bar = document.querySelector('[data-status-bar]');
    expect(bar?.textContent?.startsWith('main')).toBe(true);
    expect(document.querySelector('[data-workspace]')?.getAttribute('data-workspace')).toBe('main');
  });

  it('a plain folder (no git) shows `no git` in place of the branch and no hunk bar', async () => {
    useReadModel.getState().replaceModel(plainFolderReadModel(), 'connected');
    render(<Workspace />);
    await waitFor(() => expect(screen.getByRole('treeitem', { name: 'README.md' })).toBeTruthy());
    const bar = document.querySelector('[data-status-bar]');
    expect(bar?.textContent?.startsWith(copy.workspace.noGit)).toBe(true);
    expect(screen.getByTestId('terminal').getAttribute('data-branch')).toBe(copy.workspace.noGit);
    expect(document.querySelector('[data-workspace]')?.getAttribute('data-workspace')).toBe('no-git');
    expect(document.querySelector('[data-hunk-bar]')).toBeNull();
  });

  it('tracking off (the default outside the demo): no hunk bar even though the model carries hunks', async () => {
    const m = fixtures.demoReadModel();
    useReadModel
      .getState()
      .replaceModel(
        { ...m, settings: { ...m.settings, app: { ...m.settings.app, trackAgentEdits: false } } },
        'connected',
      );
    useUiStore.setState({ projectId: acme, projectSession: { [acme]: claude } });
    render(<Workspace />);
    await waitFor(() => expect(document.querySelector('[data-status-bar]')).not.toBeNull());
    expect(document.querySelector('[data-hunk-bar]')).toBeNull();
  });

  it('the hunk bar offers Review / Revert all / Mark reviewed (no Accept): revertAll and done per hunk session, Review opens the diff', async () => {
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected'); // Claude owns fix/checkout with 3 pending hunks
    useUiStore.setState({ projectId: acme, projectSession: { [acme]: claude } });
    render(<Workspace />);
    await waitFor(() => expect(document.querySelector('[data-hunk-bar]')).not.toBeNull());
    const bar = within(document.querySelector('[data-hunk-bar]') as HTMLElement);
    expect(bar.getByText('3 hunks from Claude · 42 tests pass')).toBeTruthy();
    expect(bar.getAllByRole('button').map((b) => b.textContent)).toEqual([
      copy.diff.review,
      copy.diff.revertAll,
      copy.diff.markReviewed,
    ]);
    expect(bar.queryByRole('button', { name: 'Accept all' })).toBeNull();
    fireEvent.click(bar.getByRole('button', { name: copy.diff.revertAll }));
    expect(commandMock).toHaveBeenCalledWith('hunk.revertAll', { sessionId: claude });
    fireEvent.click(bar.getByRole('button', { name: copy.diff.markReviewed }));
    expect(commandMock).toHaveBeenCalledWith('hunk.done', { sessionId: claude });
    expect(commandMock.mock.calls.filter(([name]) => name.startsWith('hunk.'))).toHaveLength(2);
    fireEvent.click(bar.getByRole('button', { name: copy.diff.review }));
    expect(useUiStore.getState().screen).toBe('diff');
  });
});

// @vitest-environment jsdom
import { copy, fixtures, type ProjectId } from '@styx/core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
});

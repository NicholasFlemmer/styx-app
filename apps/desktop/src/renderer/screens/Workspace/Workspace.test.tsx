// @vitest-environment jsdom
import { copy, fixtures, type ProjectId, type SessionId } from '@styx/core';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
vi.mock('../../features/preview', () => ({
  DesignPane: () => <div data-testid="design-pane" />,
}));
vi.mock('../../features/terminal/TerminalPane', () => ({
  TerminalPane: ({
    sessionId,
    worktreeId,
    branch,
    fill,
  }: {
    sessionId: string | null;
    worktreeId: string;
    branch: string;
    fill?: boolean;
  }) => (
    <div
      data-testid="terminal"
      data-session={sessionId ?? ''}
      data-worktree={worktreeId}
      data-branch={branch}
      data-fill={fill === true ? 'true' : 'false'}
    />
  ),
}));

const side = fixtures.ids.project.sideApi as ProjectId;
const sideMain = fixtures.ids.worktree.sideMain;
const acme = fixtures.ids.project.acmeShop as ProjectId;
const claude = fixtures.ids.session.claude as SessionId;

/** The tree main now returns in one call (discrepancy #115): already ordered, already marked. */
const treeNodes = () => [
  { path: 'src', name: 'src', kind: 'dir' as const, depth: 0, status: null },
  { path: 'src/server.ts', name: 'server.ts', kind: 'file' as const, depth: 1, status: null },
  { path: 'README.md', name: 'README.md', kind: 'file' as const, depth: 0, status: null },
  ...extraFiles.map((name) => ({
    path: name,
    name,
    kind: 'file' as const,
    depth: 0,
    status: '?' as const,
  })),
];
/** Files that "appear on disk" between reads (the refresh test adds one). */
let extraFiles: string[] = [];
const commandMock = vi.fn(async (name: string, input?: unknown) => {
  void input;
  if (name === 'fs.readTree') {
    return { ok: true as const, value: { nodes: treeNodes(), truncated: false } };
  }
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
      // Code, the instrument these tests drive (the default for a project without a dev server is Tasks).
      paneSizes: { 'workspace-mode': 0 },
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
    expect(commandMock).toHaveBeenCalledWith('fs.readTree', { worktreeId: sideMain, maxDepth: 4 });
    expect(screen.getByTestId('monaco').getAttribute('data-worktree')).toBe(sideMain);
    const terminal = screen.getByTestId('terminal');
    expect(terminal.getAttribute('data-session')).toBe(''); // no session yet: the terminal belongs to the worktree
    expect(terminal.getAttribute('data-worktree')).toBe(sideMain);
    expect(terminal.getAttribute('data-branch')).toBe('main');
    const bar = document.querySelector('[data-status-bar]');
    expect(bar?.textContent?.startsWith('main')).toBe(true);
    expect(document.querySelector('[data-workspace]')?.getAttribute('data-workspace')).toBe('main');
  });

  it('six instruments on the lane (ADR-0027 §2, #138, #140): Tasks the other lanes, Code the files and editor, Changes the page, Terminal fills, Preview the design window; the pick persists', async () => {
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({ projectId: acme, paneSizes: {} });
    render(<Workspace />);
    const tabs = within(screen.getByRole('tablist', { name: copy.chat.instruments.label }));
    expect(tabs.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      copy.chat.instruments.tasks,
      copy.chat.instruments.canvas,
      copy.chat.instruments.preview,
      copy.chat.instruments.changes,
      copy.chat.instruments.code,
      copy.chat.instruments.terminal,
    ]);
    // No dev server known for acme-shop in the demo: Tasks first, the project's other lanes side by side.
    expect(document.querySelector('[data-instrument]')?.getAttribute('data-instrument')).toBe('tasks');
    expect(document.querySelector('[data-tasks-board]')).not.toBeNull();
    expect(screen.queryByRole('tree')).toBeNull();
    fireEvent.click(tabs.getByRole('tab', { name: copy.chat.instruments.code }));
    expect(useUiStore.getState().paneSizes['workspace-mode']).toBe(0);
    await waitFor(() => expect(screen.getByTestId('monaco')).toBeTruthy());
    expect(screen.getByRole('tree')).toBeTruthy();

    fireEvent.click(tabs.getByRole('tab', { name: copy.chat.instruments.changes }));
    expect(document.querySelector('[data-changes-page]')).not.toBeNull();
    expect(screen.queryByTestId('monaco')).toBeNull();
    expect(screen.queryByRole('tree')).toBeNull();
    expect(useUiStore.getState().paneSizes['workspace-mode']).toBe(2);
    expect(commandMock).toHaveBeenCalledWith('ui.persist', { paneSizes: { 'workspace-mode': 2 } });

    fireEvent.click(tabs.getByRole('tab', { name: copy.chat.instruments.terminal }));
    expect(screen.getByTestId('terminal').getAttribute('data-fill')).toBe('true');
    fireEvent.click(tabs.getByRole('tab', { name: copy.chat.instruments.code }));
    expect(screen.getByTestId('terminal').getAttribute('data-fill')).toBe('false');
  });

  it('a project that knows how to run its app opens on Preview until the person picks', () => {
    const m = fixtures.demoReadModel();
    const settings = m.settings.project[acme];
    if (settings === undefined) throw new Error('fixture');
    useReadModel.getState().replaceModel(
      {
        ...m,
        settings: {
          ...m.settings,
          project: {
            ...m.settings.project,
            [acme]: { ...settings, devUrl: { ...settings.devUrl, value: 'http://localhost:3000' } },
          },
        },
      },
      'connected',
    );
    useUiStore.setState({ projectId: acme, paneSizes: {} });
    render(<Workspace />);
    expect(document.querySelector('[data-instrument]')?.getAttribute('data-instrument')).toBe('design');
  });

  it('the status bar ends with Support Styx, which opens the Buy Me a Coffee page in the browser (#120)', async () => {
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    render(<Workspace />);
    fireEvent.click(await screen.findByRole('button', { name: '☕ Buy us a coffee' }));
    expect(commandMock).toHaveBeenCalledWith('link.open', { url: 'https://buymeacoffee.com/heystyx' });
  });

  it('watches the worktree it shows and re-reads the tree when main says something on disk moved', async () => {
    extraFiles = [];
    const listeners = new Map<string, (payload: unknown) => void>();
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: fixtures.DEMO_NOW },
        command: commandMock,
        onEvent: (name: string, cb: (payload: unknown) => void) => {
          listeners.set(name, cb);
          return () => listeners.delete(name);
        },
      },
    });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    const { unmount } = render(<Workspace />);
    await waitFor(() => expect(screen.getByRole('treeitem', { name: 'README.md' })).toBeTruthy());
    expect(commandMock).toHaveBeenCalledWith('fs.watchTree', { worktreeId: sideMain });
    extraFiles = ['new-from-agent.ts'];
    expect(listeners.has('fs.treeChanged')).toBe(true);
    const listsBefore = commandMock.mock.calls.filter((c) => c[0] === 'fs.readTree').length;
    act(() => listeners.get('fs.treeChanged')?.({ worktreeId: sideMain }));
    await waitFor(() =>
      expect(commandMock.mock.calls.filter((c) => c[0] === 'fs.readTree').length).toBeGreaterThan(
        listsBefore,
      ),
    );
    await waitFor(() => expect(screen.getByRole('treeitem', { name: /new-from-agent\.ts/ })).toBeTruthy());
    // Another lane's change is not this pane's business.
    const before = commandMock.mock.calls.filter((c) => c[0] === 'fs.readTree').length;
    listeners.get('fs.treeChanged')?.({ worktreeId: 'someone-else' });
    expect(commandMock.mock.calls.filter((c) => c[0] === 'fs.readTree').length).toBe(before);
    unmount();
    expect(commandMock).toHaveBeenCalledWith('fs.unwatchTree', {});
    extraFiles = [];
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

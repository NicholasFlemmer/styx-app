// @vitest-environment jsdom
import { copy, fixtures, type ProjectId } from '@styx/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { plainFolderReadModel } from '../../test-support/plain-folder';
import { Repo } from './Repo';

const acme = fixtures.ids.project.acmeShop as ProjectId;
const notFound = { ok: false as const, error: { code: 'not-found', message: 'no worktree' } };
const commandMock = vi.fn(async (name: string) =>
  name === 'worktree.diff' ? notFound : { ok: true as const, value: {} },
);

const rowOf = (branch: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-lane="${branch}"]`);
  if (el === null) throw new Error(`no lane ${branch}`);
  return el;
};

describe('Repo screen', () => {
  // jsdom has no layout: give the virtualized lane diff a viewport (virtual-core reads offsetWidth/Height) so rows render.
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 900 });
    commandMock.mockClear();
    Object.assign(window, {
      styx: { platform: 'darwin', env: { now: fixtures.DEMO_NOW, fixture: 'demo' }, command: commandMock },
    });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({
      overlays: [],
      screen: 'repo',
      platform: 'darwin',
      projectId: acme,
      projectSession: {},
    });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('a plain folder (no git) shows the empty state with `Initialise git` → project.gitInit; no lanes, no Fetch / + Worktree', () => {
    const side = fixtures.ids.project.sideApi as ProjectId;
    useReadModel.getState().replaceModel(plainFolderReadModel(), 'connected');
    useUiStore.setState({ projectId: side });
    render(<Repo />);
    expect(document.querySelector('[data-repo-empty]')?.getAttribute('data-repo-empty')).toBe('no-git');
    expect(screen.getByText(copy.repo.title)).toBeTruthy();
    expect(screen.getByText(copy.workspace.noGit)).toBeTruthy();
    expect(screen.getByText(copy.repo.noGit.label)).toBeTruthy();
    expect(screen.getByText(copy.repo.noGit.body)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('button', { name: copy.repo.fetch })).toBeNull();
    expect(screen.queryByRole('button', { name: copy.repo.addWorktree })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: copy.repo.noGit.cta }));
    expect(commandMock).toHaveBeenCalledWith('project.gitInit', { projectId: side });
    expect(commandMock).not.toHaveBeenCalledWith('worktree.diff', expect.anything());
  });

  it('renders the header, the prototype lanes, and selects fix/checkout with its diff below', async () => {
    render(<Repo />);
    expect(screen.getByText(copy.repo.title)).toBeTruthy();
    expect(screen.getByText('github.com/acme/shop · main ↑0 ↓2')).toBeTruthy();
    expect(screen.getByRole('button', { name: copy.repo.fetch })).toBeTruthy();
    expect(screen.getByRole('button', { name: copy.repo.addWorktree })).toBeTruthy();

    for (const [branch, changes, pr, action] of [
      ['main', 'clean · ↑0 ↓2', '—', 'Open'],
      ['fix/checkout', '+142 −38 · 3 files', '#214 draft', 'Diff'],
      ['test/flaky', 'waiting on grant', '—', 'Diff'],
      ['feat/promo', 'merged yesterday', '#212 ✓', 'Archive'],
    ] as const) {
      const row = within(rowOf(branch));
      expect(row.getByText(changes)).toBeTruthy();
      expect(row.getByText(pr)).toBeTruthy();
      expect(row.getByRole('button', { name: action })).toBeTruthy();
    }
    expect(rowOf('fix/checkout').getAttribute('data-inv')).toBe('true');
    expect(rowOf('main').getAttribute('data-inv')).toBeNull();
    expect(
      within(rowOf('test/flaky')).getByText('Codex').querySelector('[data-tone]')?.getAttribute('data-tone'),
    ).toBe('accent');

    // worktree.diff fails on the demo fixture → prototype lane diff.
    await waitFor(() => expect(screen.getByText('fix/checkout · checkout.ts · +3 −0')).toBeTruthy());
    expect(commandMock).toHaveBeenCalledWith('worktree.diff', {
      worktreeId: fixtures.ids.worktree.fixCheckout,
    });
    const region = screen.getByRole('region', { name: 'fix/checkout' });
    expect(region.getAttribute('data-rows')).toBe('9');
    expect(within(region).getByText('@@ -1,5 +1,8 @@').getAttribute('data-kind')).toBe('header');
    expect(within(region).getByText("+import { validate } from './validate'").getAttribute('data-kind')).toBe(
      'add',
    );
  });

  it('clicking a lane selects it (inverted) and requests its diff', async () => {
    render(<Repo />);
    fireEvent.click(rowOf('test/flaky'));
    expect(rowOf('test/flaky').getAttribute('data-inv')).toBe('true');
    expect(rowOf('fix/checkout').getAttribute('data-inv')).toBeNull();
    await waitFor(() =>
      expect(commandMock).toHaveBeenCalledWith('worktree.diff', {
        worktreeId: fixtures.ids.worktree.testFlaky,
      }),
    );
    expect(screen.getByRole('region', { name: 'test/flaky' })).toBeTruthy();
  });

  it('Fetch, + Worktree, and Archive dispatch worktree commands', () => {
    render(<Repo />);
    fireEvent.click(screen.getByRole('button', { name: copy.repo.fetch }));
    expect(commandMock).toHaveBeenCalledWith('worktree.fetch', { projectId: acme });
    fireEvent.click(screen.getByRole('button', { name: copy.repo.addWorktree }));
    expect(commandMock).toHaveBeenCalledWith('worktree.create', {
      projectId: acme,
      branch: 'wt-1',
      base: 'main',
    });
    fireEvent.click(within(rowOf('feat/promo')).getByRole('button', { name: 'Archive' }));
    expect(commandMock).toHaveBeenCalledWith('worktree.archive', {
      worktreeId: fixtures.ids.worktree.featPromo,
    });
    // The action click does not also change the selection.
    expect(rowOf('feat/promo').getAttribute('data-inv')).toBeNull();
  });

  it('each lane offers Commit & push / Open PR, which opens the publish modal for that worktree', () => {
    render(<Repo />);
    expect(within(rowOf('main')).getByRole('button', { name: 'Commit & push' })).toBeTruthy();
    expect(within(rowOf('fix/checkout')).getByRole('button', { name: 'Commit & push' })).toBeTruthy();
    expect(within(rowOf('feat/promo')).queryByRole('button', { name: /Commit & push|Open PR/ })).toBeNull();
    fireEvent.click(within(rowOf('test/flaky')).getByRole('button', { name: 'Open PR' }));
    expect(useUiStore.getState().overlays).toMatchObject([
      { kind: 'modal', modal: 'publish', worktreeId: fixtures.ids.worktree.testFlaky },
    ]);
    // The verb click does not select the lane.
    expect(rowOf('test/flaky').getAttribute('data-inv')).toBeNull();
  });

  it('a lane with a PR page shows the PR as a link that opens it in the browser', () => {
    render(<Repo />);
    fireEvent.click(within(rowOf('fix/checkout')).getByRole('button', { name: '#214 draft' }));
    expect(commandMock).toHaveBeenCalledWith('link.open', { url: 'https://github.com/acme/shop/pull/214' });
    expect(within(rowOf('main')).queryByRole('button', { name: '—' })).toBeNull();
  });

  it('error fixture: conflict lane reads CONFLICT; Resolve asks the lane agent to finish the merge (ADR-0025 phase B)', () => {
    useReadModel.getState().replaceModel(fixtures.errorReadModel(), 'connected');
    render(<Repo />);
    const row = within(rowOf('fix/checkout'));
    expect(row.getByText('CONFLICT · checkout.ts vs main')).toBeTruthy();
    fireEvent.click(row.getByRole('button', { name: 'Resolve' }));
    expect(commandMock).toHaveBeenCalledWith('worktree.resolve', {
      worktreeId: fixtures.ids.worktree.fixCheckout,
    });
    expect(commandMock).not.toHaveBeenCalledWith('worktree.openInIde', expect.anything());
  });
});

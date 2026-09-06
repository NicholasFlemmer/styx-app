// @vitest-environment jsdom
import { copy, fixtures, homeActivity, homeProjectRows } from '@styx/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { Home } from './Home';

let picked: string | null = '/Users/me/C21';
const commandMock = vi.fn(async (name: string, _input?: unknown) => {
  if (name === 'dialog.pickFolder') return { ok: true as const, value: { path: picked } };
  if (name === 'project.add') return { ok: true as const, value: { projectId: 'project-added' } };
  return { ok: true as const, value: {} };
});
const calls = (name: string) => commandMock.mock.calls.filter((c) => c[0] === name);

describe('Home', () => {
  beforeEach(() => {
    commandMock.mockClear();
    picked = '/Users/me/C21';
    Object.assign(window, {
      styx: { platform: 'darwin', env: { now: fixtures.DEMO_NOW }, command: commandMock },
    });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({ overlays: [], screen: 'home', platform: 'darwin', projectId: null });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('renders the four zero-padded counters in spec order', () => {
    render(<Home />);
    const labels = [
      copy.counters.needsYou,
      copy.counters.agentsWorking,
      copy.counters.grantsActive,
      copy.counters.projects,
    ];
    const values = labels.map((l) => screen.getByText(l).previousElementSibling?.textContent);
    expect(values).toEqual(['02', '03', '02', '05']);
    // The titlebar counter is the one needs-you live region; the tile must not announce a second time.
    expect(screen.getByText(copy.counters.needsYou).parentElement?.getAttribute('aria-live')).toBeNull();
  });

  it('renders one row per project with the core selector strings and the needs-you dot', () => {
    render(<Home />);
    const expected = homeProjectRows(useReadModel.getState().model, fixtures.DEMO_NOW);
    const table = screen.getByRole('table');
    const rows = within(table)
      .getAllByRole('row')
      .filter((r) => r.hasAttribute('data-project-id'));
    expect(rows).toHaveLength(expected.length);
    rows.forEach((row, i) => {
      const e = expected[i];
      if (e === undefined) throw new Error('row mismatch');
      const cells = within(row)
        .getAllByRole('cell')
        .map((c) => c.textContent);
      expect(cells).toEqual([e.name, e.path, e.branch, e.agents, e.targets, e.last]);
      const dot = row.querySelector('[data-tone="hollow"]');
      expect(dot?.getAttribute('data-on')).toBe(e.needs ? 'true' : null);
    });
    expect(expected[0]?.agents).toBe('Claude, Codex, Gemini');
    expect(expected[0]?.last).toBe('2m');
  });

  it('row click selects the project, tells main, and opens Workspace', () => {
    render(<Home />);
    const acme = fixtures.ids.project.acmeShop;
    const row = screen.getByRole('table').querySelector(`[data-project-id="${acme}"]`);
    if (row === null) throw new Error('no acme row');
    fireEvent.click(row);
    const ui = useUiStore.getState();
    expect(ui.projectId).toBe(acme);
    expect(ui.screen).toBe('workspace');
    expect(commandMock).toHaveBeenCalledWith('project.select', { projectId: acme });
  });

  it('Enter on a focused row activates it too', () => {
    render(<Home />);
    const blog = fixtures.ids.project.blogV2;
    const row = screen.getByRole('table').querySelector(`[data-project-id="${blog}"]`);
    if (row === null) throw new Error('no blog row');
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(useUiStore.getState().projectId).toBe(blog);
  });

  it('+ New project and + Clone URL push the new-project modal', () => {
    render(<Home />);
    fireEvent.click(screen.getByRole('button', { name: copy.home.addRow.newProject }));
    expect(useUiStore.getState().overlays).toMatchObject([{ kind: 'modal', modal: 'new-project' }]);
    useUiStore.setState({ overlays: [] });
    fireEvent.click(screen.getByRole('button', { name: copy.home.addRow.cloneUrl }));
    expect(useUiStore.getState().overlays).toMatchObject([{ kind: 'modal', modal: 'new-project' }]);
  });

  it('+ Open folder dispatches nothing until a folder picker exists', async () => {
    render(<Home />);
    fireEvent.click(screen.getByRole('button', { name: copy.home.addRow.openFolder }));
    await Promise.resolve();
    expect(commandMock).not.toHaveBeenCalledWith('project.add', expect.anything());
  });

  it('renders the activity feed newest first in mono, with the prototype line', () => {
    render(<Home />);
    const feed = screen.getByRole('list', { name: copy.home.activity });
    const items = within(feed).getAllByRole('listitem');
    const expected = homeActivity(useReadModel.getState().model, fixtures.DEMO_NOW);
    expect(items.map((li) => li.textContent)).toEqual(expected.map((r) => `${r.t}${r.who}${r.what}`));
    expect(items[0]?.textContent).toBe('2mClaudeacme-shop · edited checkout.ts, pay.ts · 42 tests pass');
  });

  describe('empty fixture', () => {
    beforeEach(() => {
      useReadModel.getState().replaceModel(fixtures.emptyReadModel(), 'connected');
    });

    it('shows the empty state with verbatim copy, keeps header, add row and Activity label', () => {
      render(<Home />);
      expect(screen.getByText(copy.empty.projects.headline)).toBeTruthy();
      expect(screen.getByText(copy.empty.projects.bodyPrototype)).toBeTruthy();
      expect(screen.getByRole('columnheader', { name: copy.home.columns.project })).toBeTruthy();
      expect(screen.getByRole('table').querySelectorAll('[data-project-id]')).toHaveLength(0);
      expect(screen.getByRole('button', { name: copy.home.addRow.newProject })).toBeTruthy();
      expect(screen.getByText(copy.home.activity)).toBeTruthy();
      expect(
        within(screen.getByRole('list', { name: copy.home.activity })).queryAllByRole('listitem'),
      ).toHaveLength(0);
    });

    it('Scan this machine dispatches project.scan; New project opens the modal', () => {
      render(<Home />);
      fireEvent.click(screen.getByRole('button', { name: copy.empty.projects.scan }));
      expect(commandMock).toHaveBeenCalledWith('project.scan', { includeIdeRecents: true });
      fireEvent.click(screen.getByRole('button', { name: copy.empty.projects.newProject }));
      expect(useUiStore.getState().overlays).toMatchObject([{ kind: 'modal', modal: 'new-project' }]);
    });

    it('counters read 00 except grants', () => {
      render(<Home />);
      expect(screen.getByText(copy.counters.projects).previousElementSibling?.textContent).toBe('00');
      expect(screen.getByText(copy.counters.needsYou).previousElementSibling?.textContent).toBe('00');
    });
  });
  it('add row: + Open folder picks a folder via main, adds it and opens its Workspace; dismissed = no-op', async () => {
    render(<Home />);
    fireEvent.click(screen.getByRole('button', { name: copy.home.addRow.openFolder }));
    await waitFor(() => expect(useUiStore.getState().screen).toBe('workspace'));
    expect(calls('dialog.pickFolder')).toHaveLength(1);
    expect(calls('project.add').map((c) => c[1])).toEqual([{ path: '/Users/me/C21' }]);
    expect(calls('project.select').map((c) => c[1])).toEqual([{ projectId: 'project-added' }]);
    expect(useUiStore.getState().projectId).toBe('project-added');

    picked = null;
    commandMock.mockClear();
    useUiStore.setState({ screen: 'home', projectId: null });
    fireEvent.click(screen.getByRole('button', { name: copy.home.addRow.openFolder }));
    await waitFor(() => expect(calls('dialog.pickFolder')).toHaveLength(1));
    expect(calls('project.add')).toHaveLength(0);
    expect(useUiStore.getState().screen).toBe('home');
  });

  it('add row: + New project opens the default modal and + Clone URL opens it in clone mode', () => {
    render(<Home />);
    fireEvent.click(screen.getByRole('button', { name: copy.home.addRow.newProject }));
    expect(useUiStore.getState().overlays).toMatchObject([{ kind: 'modal', modal: 'new-project' }]);
    useUiStore.setState({ overlays: [] });
    fireEvent.click(screen.getByRole('button', { name: copy.home.addRow.cloneUrl }));
    expect(useUiStore.getState().overlays).toMatchObject([
      { kind: 'modal', modal: 'new-project', mode: 'clone' },
    ]);
  });
});

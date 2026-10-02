// @vitest-environment jsdom
import { copy, fixtures, homeActivity, homeGreeting, homeProjectRows } from '@styx/core';
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

  it('heads with a greeting and one line, then the four counters: needs you (accent), working, ready to land, grants', () => {
    render(<Home />);
    const m = useReadModel.getState().model;
    const name = m.account.kind === 'signed-in' ? m.account.account.name : null;
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(
      homeGreeting(new Date(fixtures.DEMO_NOW).getHours(), name),
    );
    expect(screen.getByText('2 things need you. 3 agents are working.')).toBeTruthy();
    const labels = [
      copy.counters.needsYou,
      copy.counters.agentsWorking,
      copy.home.readyToLand,
      copy.counters.grantsActive,
    ];
    const counters = within(document.querySelector('[data-home-counters]') as HTMLElement);
    const values = labels.map((l) => counters.getByText(l).previousElementSibling?.textContent);
    expect(values).toEqual(['02', '03', '00', '02']);
    expect(counters.getByText(copy.counters.needsYou).parentElement?.getAttribute('data-attention')).toBe(
      'true',
    );
    // The titlebar counter is the one needs-you live region; the tile must not announce a second time.
    expect(counters.getByText(copy.counters.needsYou).parentElement?.getAttribute('aria-live')).toBeNull();
  });

  it('one row per project with its lanes, most urgent first; a project with nothing running offers a task', () => {
    render(<Home />);
    const expected = homeProjectRows(useReadModel.getState().model, fixtures.DEMO_NOW);
    const rows = Array.from(document.querySelectorAll('[data-project-id]'));
    expect(rows).toHaveLength(expected.length);
    rows.forEach((row, i) => {
      const e = expected[i];
      if (e === undefined) throw new Error('row mismatch');
      expect(row.textContent).toContain(e.name);
      expect(row.querySelectorAll('[data-home-lane]').length).toBe(Math.min(3, e.lanes.length));
      const dot = row.querySelector('[data-tone="hollow"]');
      expect(dot?.getAttribute('data-on')).toBe(e.needs ? 'true' : null);
    });
    const acme = document.querySelector(
      `[data-project-id="${fixtures.ids.project.acmeShop}"]`,
    ) as HTMLElement;
    expect(acme.querySelector('[data-home-lane]')?.getAttribute('data-status')).toBe('your-turn');
    const idle = rows.find((r) => r.querySelectorAll('[data-home-lane]').length === 0) as
      HTMLElement | undefined;
    if (idle !== undefined) {
      fireEvent.click(within(idle).getByRole('button', { name: copy.home.startTask }));
      expect(useUiStore.getState().newTask?.projectId).toBe(idle.getAttribute('data-project-id'));
    }
  });

  it('the project opens its workspace (and tells main); a lane chip opens that lane', () => {
    render(<Home />);
    const acme = fixtures.ids.project.acmeShop;
    const row = document.querySelector(`[data-project-id="${acme}"]`) as HTMLElement;
    fireEvent.click(within(row).getAllByRole('button')[0] as HTMLElement);
    expect(useUiStore.getState()).toMatchObject({ projectId: acme, screen: 'workspace' });
    expect(commandMock).toHaveBeenCalledWith('project.select', { projectId: acme });
    useUiStore.setState({ screen: 'home' });
    const chip = row.querySelector('[data-home-lane]') as HTMLElement;
    fireEvent.click(chip);
    expect(useUiStore.getState().projectSession[acme]).toBe(chip.getAttribute('data-home-lane'));
    expect(useUiStore.getState().screen).toBe('workspace');
  });

  it('New task in the head opens New task for the current project', () => {
    useUiStore.setState({ projectId: fixtures.ids.project.blogV2 });
    render(<Home />);
    fireEvent.click(document.querySelector('[data-home-new-task]') as HTMLElement);
    expect(useUiStore.getState().newTask).toEqual({ projectId: fixtures.ids.project.blogV2, text: '' });
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

  it('renders what happened newest first, with the prototype line', () => {
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

    it('shows the empty state with verbatim copy, keeps the add row and the activity heading', () => {
      render(<Home />);
      expect(screen.getByText(copy.empty.projects.headline)).toBeTruthy();
      expect(screen.getByText(copy.empty.projects.bodyPrototype)).toBeTruthy();
      expect(document.querySelectorAll('[data-project-id]')).toHaveLength(0);
      expect(document.querySelector('[data-home-new-task]')).toBeNull();
      expect(screen.getByRole('button', { name: copy.home.addRow.newProject })).toBeTruthy();
      expect(screen.getByText(copy.home.activity)).toBeTruthy();
      expect(
        within(screen.getByRole('list', { name: copy.home.activity })).queryAllByRole('listitem'),
      ).toHaveLength(0);
    });

    it('Scan this machine opens the Add from recent modal; New project opens its modal', () => {
      render(<Home />);
      fireEvent.click(screen.getByRole('button', { name: copy.empty.projects.scan }));
      expect(useUiStore.getState().overlays).toMatchObject([{ kind: 'modal', modal: 'add-existing' }]);
      useUiStore.setState({ overlays: [] });
      fireEvent.click(screen.getByRole('button', { name: copy.empty.projects.newProject }));
      expect(useUiStore.getState().overlays).toMatchObject([{ kind: 'modal', modal: 'new-project' }]);
    });

    it('counters read 00 except grants', () => {
      render(<Home />);
      expect(screen.getByText(copy.home.readyToLand).previousElementSibling?.textContent).toBe('00');
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

// @vitest-environment jsdom
import { copy, fixtures } from '@styx/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../state/read-model';
import { useUiStore } from '../state/ui-store';
import { AppRail, RailSettings } from './AppRail';
import { Nav } from './Nav';

const { ids } = fixtures;
const tile = (name: string | RegExp) => screen.getByRole('button', { name });

describe('rail + project nav (ADR-0027 §1, §5)', () => {
  beforeEach(() => {
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: fixtures.DEMO_NOW },
        command: vi.fn(async () => ({ ok: true, value: {} })),
      },
    });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({
      overlays: [],
      screen: 'workspace',
      platform: 'darwin',
      projectId: ids.project.acmeShop,
      settingsSection: 'project:targets',
      boardScope: 'project',
    });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('holds only the app’s places; Settings is one tile at the foot that opens the Settings screen', () => {
    render(
      <>
        <AppRail />
        <RailSettings />
      </>,
    );
    const rail = screen.getByRole('navigation', { name: copy.appRail.label });
    const titles = Array.from(rail.querySelectorAll('button')).map((b) => b.getAttribute('title'));
    expect(titles).toEqual([
      copy.appRail.home.title,
      copy.appRail.agents.title,
      copy.appRail.approvals.title,
      copy.appRail.tasks.title,
      copy.appRail.usage.title,
    ]);
    for (const b of rail.querySelectorAll('button')) expect(b.querySelector('svg')).not.toBeNull();
    // No app settings section has a tile of its own any more.
    for (const name of Object.values(copy.appRail.sections))
      expect(screen.queryByRole('button', { name })).toBeNull();
    const settings = tile(copy.appRail.settings.title);
    fireEvent.click(settings);
    expect(useUiStore.getState().screen).toBe('settings');
    expect(settings.getAttribute('aria-current')).toBe('page');
  });

  it('places: All projects and Access (count in its name) are pages; Tasks opens the modeless dialog', () => {
    render(<AppRail />);
    const approvals = tile(/^Access · \d+ in the inbox$/);
    const home = tile(copy.appRail.home.title);
    fireEvent.click(home);
    expect(useUiStore.getState().screen).toBe('home');
    expect(home.getAttribute('aria-current')).toBe('page');
    fireEvent.click(approvals);
    expect(useUiStore.getState().screen).toBe('approvals');
    const tasks = tile(copy.appRail.tasks.title);
    expect(tasks.getAttribute('aria-haspopup')).toBe('dialog');
    expect(tasks.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(tasks);
    expect(useUiStore.getState().overlays.at(-1)).toMatchObject({ kind: 'task' });
    expect(tile(copy.appRail.tasks.title).getAttribute('aria-expanded')).toBe('true');
  });

  it('All agents shows every project; the nav’s Agents row shows the project’s; each is current for its own scope', () => {
    render(
      <>
        <AppRail />
        <Nav />
      </>,
    );
    fireEvent.click(tile(copy.appRail.agents.title));
    expect(useUiStore.getState()).toMatchObject({ screen: 'agents', boardScope: 'all' });
    expect(tile(copy.appRail.agents.title).getAttribute('aria-current')).toBe('page');
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    const row = nav.querySelector('[data-nav-item="agents"]') as HTMLElement;
    expect(row.getAttribute('aria-current')).toBeNull();
    fireEvent.click(row);
    expect(useUiStore.getState()).toMatchObject({ screen: 'agents', boardScope: 'project' });
    expect(row.getAttribute('aria-current')).toBe('page');
    expect(tile(copy.appRail.agents.title).getAttribute('aria-current')).toBeNull();
  });

  it('the nav’s project options open their Settings section directly', () => {
    render(<Nav />);
    fireEvent.click(screen.getByRole('button', { name: copy.settings.project.env }));
    expect(useUiStore.getState()).toMatchObject({ screen: 'settings', settingsSection: 'project:env' });
    fireEvent.click(screen.getByRole('button', { name: copy.settings.project.targets }));
    expect(useUiStore.getState()).toMatchObject({ screen: 'settings', settingsSection: 'project:targets' });
  });

  it('the project nav: the project head opens its workspace, then the work, then the project’s tools', () => {
    act(() => useUiStore.setState({ screen: 'home' }));
    render(<Nav />);
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    expect(nav.textContent).toContain('acme-shop');
    expect(nav.querySelector('[data-nav-branch]')?.textContent).toBe('Branch fix/checkout');
    fireEvent.click(nav.querySelector('[data-nav-item="workspace"]') as HTMLElement);
    expect(useUiStore.getState().screen).toBe('workspace');
    const groups = Array.from(nav.querySelectorAll('[data-nav-group]')).map((g) =>
      g.getAttribute('data-nav-group'),
    );
    expect(groups).toEqual(['work', 'project']);
    const rows = Array.from(nav.querySelectorAll('[data-nav-item]')).map((b) =>
      b.getAttribute('data-nav-item'),
    );
    expect(rows).toEqual([
      'workspace',
      'repo',
      'agents',
      'project:targets',
      'project:agent-defaults',
      'project:env',
    ]);
    for (const b of nav.querySelectorAll(
      'button[data-nav-item]:not([data-nav-item="workspace"]), [data-nav-audit]',
    ))
      expect(b.querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('button', { name: copy.debtAudit.action })).toBeTruthy();
  });

  it('lists the project’s lanes, your turn first, and opens one in the workspace; New task takes the workspace', () => {
    act(() => useUiStore.setState({ screen: 'repo' }));
    render(<Nav />);
    const list = screen.getByRole('list', { name: copy.lanes.nav.label });
    const lanes = Array.from(list.querySelectorAll('[data-nav-lane]'));
    expect(lanes.length).toBeGreaterThan(1);
    const statuses = lanes.map((l) => l.getAttribute('data-lane-status'));
    expect(statuses[0]).toBe('your-turn');
    expect(lanes[0]?.textContent).toContain(copy.lanes.nav.status['your-turn']);
    // Nothing is current outside the workspace.
    expect(list.querySelector('[aria-current="page"]')).toBeNull();
    const target = lanes[1] as HTMLElement;
    const id = target.getAttribute('data-nav-lane');
    fireEvent.click(target);
    const ui = useUiStore.getState();
    expect(ui.screen).toBe('workspace');
    expect(ui.projectSession[ids.project.acmeShop]).toBe(id);
    expect(list.querySelector(`[data-nav-lane="${id}"]`)?.getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByRole('button', { name: `+ ${copy.lanes.nav.newTask}` }));
    expect(useUiStore.getState().newTask).toEqual({ projectId: ids.project.acmeShop, text: '' });
    expect(useUiStore.getState().screen).toBe('workspace');
    // While New task has the workspace, no lane is current.
    expect(list.querySelector('[aria-current="page"]')).toBeNull();
  });
});

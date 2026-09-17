// @vitest-environment jsdom
import { copy, fixtures } from '@styx/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../state/read-model';
import { useUiStore } from '../state/ui-store';
import { AppRail } from './AppRail';
import { Nav } from './Nav';

const { ids } = fixtures;
const tile = (name: string | RegExp) => screen.getByRole('button', { name });

describe('app rail + project nav (owner layout, discrepancies #85 / #87)', () => {
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

  it('holds the global places, then every App settings section as its own icon tile, in the Settings nav order', () => {
    render(<AppRail />);
    const rail = screen.getByRole('navigation', { name: copy.appRail.label });
    const titles = Array.from(rail.querySelectorAll('button')).map((b) => b.getAttribute('title'));
    expect(titles).toEqual([
      copy.appRail.home.title,
      copy.appRail.agents.title,
      copy.appRail.approvals.title,
      copy.appRail.tasks.title,
      copy.appRail.usage.title,
      ...Object.values(copy.appRail.sections),
    ]);
    // Every tile is an icon, not text: nothing hides behind a menu any more.
    for (const b of rail.querySelectorAll('button')) expect(b.querySelector('svg')).not.toBeNull();
  });

  it('places: All projects and Approvals (count in its name) are pages; Tasks opens the modeless dialog', () => {
    render(<AppRail />);
    const approvals = tile(/^Approvals · \d+ in the inbox$/);
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

  it('each settings tile opens its App section directly; the nav’s Project settings opens the Project group', () => {
    render(
      <>
        <AppRail />
        <Nav />
      </>,
    );
    fireEvent.click(tile(copy.appRail.sections['app:agents']));
    expect(useUiStore.getState()).toMatchObject({ screen: 'settings', settingsSection: 'app:agents' });
    expect(tile(copy.appRail.sections['app:agents']).getAttribute('aria-current')).toBe('page');
    expect(tile(copy.appRail.sections['app:general']).getAttribute('aria-current')).toBeNull();
    fireEvent.click(tile(copy.appRail.sections['app:keychain']));
    expect(useUiStore.getState().settingsSection).toBe('app:keychain');
    // The project's options are rows in its nav, no Settings tab in between (owner request #88).
    fireEvent.click(screen.getByRole('button', { name: copy.settings.project.env }));
    expect(useUiStore.getState()).toMatchObject({ screen: 'settings', settingsSection: 'project:env' });
    fireEvent.click(screen.getByRole('button', { name: copy.settings.project.targets }));
    expect(useUiStore.getState()).toMatchObject({ screen: 'settings', settingsSection: 'project:targets' });
    expect(tile(copy.appRail.sections['app:keychain']).getAttribute('aria-current')).toBeNull();
    // A section set elsewhere (a banner's Agents link) lights the matching tile.
    act(() => useUiStore.setState({ screen: 'settings', settingsSection: 'app:editor' }));
    expect(tile(copy.appRail.sections['app:editor']).getAttribute('aria-current')).toBe('page');
  });

  it('the project nav shows the project’s details and only its places, each row with its icon', () => {
    render(<Nav />);
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    expect(nav.textContent).toContain('acme-shop');
    expect(nav.querySelector('[data-nav-branch]')?.textContent).toBe('Branch fix/checkout');
    const rows = Array.from(nav.querySelectorAll('[data-nav-item]')).map((b) =>
      b.getAttribute('data-nav-item'),
    );
    expect(rows).toEqual([
      'workspace',
      'agents',
      'repo',
      'project:targets',
      'project:agent-defaults',
      'project:env',
    ]);
    for (const b of nav.querySelectorAll('[data-nav-item], [data-nav-audit]'))
      expect(b.querySelector('svg')).not.toBeNull();
    expect(nav.querySelector('[data-nav-tasks]')).toBeNull();
    expect(screen.getByRole('button', { name: copy.debtAudit.action })).toBeTruthy();
  });
});

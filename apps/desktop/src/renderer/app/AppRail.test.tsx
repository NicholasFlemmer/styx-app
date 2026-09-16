// @vitest-environment jsdom
import { copy, fixtures } from '@styx/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../state/read-model';
import { useUiStore } from '../state/ui-store';
import { AppRail } from './AppRail';
import { Nav } from './Nav';

const { ids } = fixtures;

describe('app rail + project nav (owner layout, discrepancy #85)', () => {
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
    });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('the app rail holds the global places: All projects, Approvals (corner while the inbox has rows), Tasks, App settings', () => {
    render(<AppRail />);
    const rail = screen.getByRole('navigation', { name: copy.appRail.label });
    const names = Array.from(rail.querySelectorAll('button')).map((b) => b.getAttribute('title'));
    expect(names).toEqual([
      copy.appRail.home.title,
      copy.appRail.approvals.title,
      copy.appRail.tasks.title,
      copy.appRail.settings.title,
    ]);
    // The demo inbox has open asks: the Approvals tile carries the count in its accessible name (the old nav row's
    // meta), and navigation tiles are the current *page*, not a current item.
    const approvals = screen.getByRole('button', { name: /^Approvals · \d+ in the inbox$/ });
    expect(approvals).toBeTruthy();
    const home = screen.getByRole('button', { name: copy.appRail.home.title });
    fireEvent.click(home);
    expect(useUiStore.getState().screen).toBe('home');
    expect(home.getAttribute('aria-current')).toBe('page');
    fireEvent.click(approvals);
    expect(useUiStore.getState().screen).toBe('approvals');
    // Tasks opens a modeless dialog: the tile says so and reflects it while it is open.
    const tasks = screen.getByRole('button', { name: copy.appRail.tasks.title });
    expect(tasks.getAttribute('aria-haspopup')).toBe('dialog');
    expect(tasks.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(tasks);
    expect(useUiStore.getState().overlays.at(-1)).toMatchObject({ kind: 'task' });
    expect(screen.getByRole('button', { name: copy.appRail.tasks.title }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('App settings opens the App group; the nav’s Project settings opens the Project group; each swaps a stale section', () => {
    render(
      <>
        <AppRail />
        <Nav />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: copy.appRail.settings.title }));
    expect(useUiStore.getState()).toMatchObject({ screen: 'settings', settingsSection: 'app:general' });
    expect(
      screen.getByRole('button', { name: copy.appRail.settings.title }).getAttribute('aria-current'),
    ).toBe('page');
    fireEvent.click(screen.getByRole('button', { name: copy.nav.projectSettings }));
    expect(useUiStore.getState()).toMatchObject({ screen: 'settings', settingsSection: 'project:targets' });
    expect(
      screen.getByRole('button', { name: copy.appRail.settings.title }).getAttribute('aria-current'),
    ).toBeNull();
    // A specific app section set elsewhere (a banner's "Agents" link) survives the app-rail route.
    act(() => useUiStore.setState({ screen: 'workspace', settingsSection: 'app:agents' }));
    fireEvent.click(screen.getByRole('button', { name: copy.appRail.settings.title }));
    expect(useUiStore.getState().settingsSection).toBe('app:agents');
  });

  it('the project nav shows the project’s details (name, branch) and only its places; no Home, Approvals or Tasks rows', () => {
    render(<Nav />);
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    expect(nav.textContent).toContain('acme-shop');
    expect(nav.querySelector('[data-nav-branch]')?.textContent).toBe('Branch fix/checkout');
    const rows = Array.from(nav.querySelectorAll('[data-nav-item]')).map((b) =>
      b.getAttribute('data-nav-item'),
    );
    expect(rows).toEqual(['workspace', 'agents', 'repo', 'settings']);
    expect(nav.querySelector('[data-nav-tasks]')).toBeNull();
    expect(screen.getByRole('button', { name: copy.debtAudit.action })).toBeTruthy();
  });
});

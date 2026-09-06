// @vitest-environment jsdom
import { copy, fixtures } from '@styx/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../state/read-model';
import { useUiStore } from '../state/ui-store';
import { Rail } from './Rail';

let picked: string | null = '/Users/me/AmrodOrders';
const commandMock = vi.fn(async (name: string, _input?: unknown) => {
  if (name === 'dialog.pickFolder') return { ok: true as const, value: { path: picked } };
  if (name === 'project.add') return { ok: true as const, value: { projectId: 'project-added' } };
  return { ok: true as const, value: {} };
});
const calls = (name: string) => commandMock.mock.calls.filter((c) => c[0] === name);

const openMenu = () => {
  fireEvent.click(screen.getByRole('button', { name: copy.rail.add }));
  return screen.getByRole('menu', { name: copy.rail.add });
};

describe('Rail "+" menu', () => {
  beforeEach(() => {
    commandMock.mockClear();
    picked = '/Users/me/AmrodOrders';
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

  it('opens a four-row menu from the + tile with the first row focused; ↑/↓ wrap, Esc closes and refocuses the tile', () => {
    render(<Rail />);
    const tile = screen.getByRole('button', { name: copy.rail.add });
    expect(tile.getAttribute('aria-haspopup')).toBe('menu');
    expect(tile.getAttribute('aria-expanded')).toBe('false');
    const menu = openMenu();
    expect(tile.getAttribute('aria-expanded')).toBe('true');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      copy.rail.menu.newProject,
      copy.rail.menu.addExisting,
      copy.rail.menu.openFolder,
      copy.rail.menu.cloneUrl,
    ]);
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[3]);
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(tile);
    expect(useUiStore.getState().overlays).toEqual([]);
  });

  it('New project… opens the modal in its default mode; Clone URL… opens it in clone mode; focus returns to the tile', () => {
    render(<Rail />);
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: copy.rail.menu.newProject }));
    expect(useUiStore.getState().overlays).toMatchObject([{ kind: 'modal', modal: 'new-project' }]);
    expect(useUiStore.getState().overlays[0]).not.toHaveProperty('mode');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: copy.rail.add }));
    useUiStore.setState({ overlays: [] });
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: copy.rail.menu.cloneUrl }));
    expect(useUiStore.getState().overlays).toMatchObject([
      { kind: 'modal', modal: 'new-project', mode: 'clone' },
    ]);
  });

  it('Open folder… asks main for a folder, adds it, selects it and lands in Workspace; a dismissed picker does nothing', async () => {
    render(<Rail />);
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: copy.rail.menu.openFolder }));
    await waitFor(() => expect(useUiStore.getState().screen).toBe('workspace'));
    expect(calls('project.add').map((c) => c[1])).toEqual([{ path: '/Users/me/AmrodOrders' }]);
    expect(calls('project.select').map((c) => c[1])).toEqual([{ projectId: 'project-added' }]);
    expect(useUiStore.getState().projectId).toBe('project-added');

    picked = null;
    useUiStore.setState({ screen: 'home', projectId: null });
    commandMock.mockClear();
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: copy.rail.menu.openFolder }));
    await waitFor(() => expect(calls('dialog.pickFolder')).toHaveLength(1));
    expect(calls('project.add')).toHaveLength(0);
    expect(useUiStore.getState().screen).toBe('home');
  });

  it('a mousedown outside closes the menu; Enter on a focused row activates it', () => {
    render(<Rail />);
    const menu = openMenu();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
    openMenu();
    const row = within(screen.getByRole('menu')).getByRole('menuitem', { name: copy.rail.menu.newProject });
    expect(document.activeElement).toBe(row);
    // Enter on a focused <button> fires click natively; testing-library's click stands in for that.
    fireEvent.click(row);
    expect(useUiStore.getState().overlays).toHaveLength(1);
    expect(menu.isConnected).toBe(false);
  });
});

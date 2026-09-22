// @vitest-environment jsdom
import { copy, fixtures, flattenPalette, paletteResults, type ProjectId } from '@styx/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { Palette } from './Palette';

const acme = fixtures.ids.project.acmeShop as ProjectId;

describe('Palette', () => {
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
      projectId: acme,
      palette: { query: '', scope: 'all', activeId: null },
    });
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('renders core paletteResults groups with the first row preselected', () => {
    const id = useUiStore.getState().pushOverlay({ kind: 'palette' });
    render(<Palette id={id} />);
    const groups = paletteResults(
      useReadModel.getState().model,
      { projectId: acme },
      '',
      'all',
      fixtures.DEMO_NOW,
    );
    for (const g of groups) expect(screen.getByText(g.label)).toBeTruthy();
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(flattenPalette(groups).length);
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('combobox')).toBe(document.activeElement);
  });

  it('filters on the query and Tab cycles the scope', () => {
    const id = useUiStore.getState().pushOverlay({ kind: 'palette' });
    render(<Palette id={id} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'switch' } });
    expect(useUiStore.getState().palette.query).toBe('switch');
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(useUiStore.getState().palette.scope).toBe('actions');
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    expect(useUiStore.getState().palette.scope).toBe('all');
  });

  it('Enter on a project row switches project and closes the palette', () => {
    useUiStore.setState({ projectId: acme, screen: 'home' });
    const id = useUiStore.getState().pushOverlay({ kind: 'palette' });
    useUiStore.getState().setPalette({ scope: 'projects' });
    render(<Palette id={id} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'blog' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const ui = useUiStore.getState();
    expect(ui.overlays).toHaveLength(0);
    expect(ui.projectId).not.toBe(acme);
    expect(ui.screen).toBe('workspace');
  });

  it('spawn row opens the spawn modal; Mod+Enter on an agent pops it out', () => {
    const id = useUiStore.getState().pushOverlay({ kind: 'palette' });
    render(<Palette id={id} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: copy.palette.actions.spawn.replace('{project}', 'acme') } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const top = useUiStore.getState().overlays[0];
    expect(top?.kind === 'modal' && top.modal === 'spawn').toBe(true);
  });

  it('publish row opens the publish modal for the branch the project is on', () => {
    const id = useUiStore.getState().pushOverlay({ kind: 'palette' });
    render(<Palette id={id} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'Publish acme' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useUiStore.getState().overlays).toMatchObject([
      { kind: 'modal', modal: 'publish', worktreeId: fixtures.ids.worktree.fixCheckout },
    ]);
  });

  it('"Play while you wait" opens Snake for the working tab and remembers the invoker (discrepancy row 110)', () => {
    useUiStore.setState({ projectSession: { [acme]: fixtures.ids.session.claude } });
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    const id = useUiStore.getState().pushOverlay({ kind: 'palette' });
    render(<Palette id={id} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'snake' } });
    expect(screen.getAllByRole('option')[0]?.textContent).toContain(copy.arcade.action);
    fireEvent.keyDown(input, { key: 'Enter' });
    const ui = useUiStore.getState();
    expect(ui.overlays).toHaveLength(0);
    expect(ui.arcade).toMatchObject({ sessionId: fixtures.ids.session.claude, held: false, countdown: null });
    expect(ui.arcade?.game.phase).toBe('ready');
    expect(ui.screen).toBe('workspace');
    button.remove();
  });

  it('Mod+Enter on an agent row requests a new window', () => {
    const id = useUiStore.getState().pushOverlay({ kind: 'palette' });
    render(<Palette id={id} />);
    act(() => useUiStore.getState().setPalette({ scope: 'agents' }));
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    const cmd = (window as unknown as { styx: { command: ReturnType<typeof vi.fn> } }).styx.command;
    expect(cmd).toHaveBeenCalledWith(
      'window.popout',
      expect.objectContaining({ sessionId: expect.any(String) }),
    );
    expect(useUiStore.getState().overlays).toHaveLength(0);
  });
});

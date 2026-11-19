// @vitest-environment jsdom
import { copy, fixtures, oneNeeds, oneTasks } from '@styx/core';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { OneHome } from './OneHome';
import { OneNav } from './OneNav';
import { OneNeeds } from './OneNeeds';
import { OneProject } from './OneProjects';

const commandMock = vi.fn(async (_name: string, _input?: unknown) => ({ ok: true as const, value: {} }));
const model = fixtures.demoReadModel();
const NOW = fixtures.DEMO_NOW;

describe('One place for the work (ADR-0033)', () => {
  beforeEach(() => {
    commandMock.mockClear();
    Object.assign(window, { styx: { platform: 'darwin', env: { now: NOW }, command: commandMock } });
    useReadModel.getState().replaceModel(model, 'connected');
    useUiStore.setState({ overlays: [], screen: 'one-home', platform: 'darwin', projectId: null });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('the sidebar moves between places, counts what needs you, and switches back to classic Styx', () => {
    render(<OneNav />);
    const nav = screen.getByRole('navigation', { name: copy.one.modeLabel });
    const needs = within(nav).getByRole('button', { name: new RegExp(copy.one.nav.needs) });
    expect(needs.textContent).toContain(String(oneNeeds(model, NOW).length));
    fireEvent.click(needs);
    expect(useUiStore.getState().screen).toBe('one-needs');
    fireEvent.click(within(nav).getByRole('button', { name: /acme-shop/ }));
    expect(useUiStore.getState().screen).toBe('one-project');
    fireEvent.click(within(nav).getByRole('button', { name: copy.one.nav.classic }));
    expect(commandMock).toHaveBeenCalledWith('settings.set', { patch: { oneMode: false } });
  });

  it('Home lists every task in plain words, and a card opens its task', () => {
    render(<OneHome />);
    const first = oneTasks(model, NOW)[0];
    if (first === undefined) throw new Error('fixture');
    const card = document.querySelector(`[data-one-task="${first.sessionId}"]`);
    expect(card?.textContent).toContain(first.line);
    if (card === null) throw new Error('card');
    fireEvent.click(card);
    expect(useUiStore.getState().screen).toBe('workspace');
    expect(screen.getByRole('textbox', { name: copy.one.ask })).toBeTruthy();
  });

  it('Needs your OK opens the grant sheet for an access request, and lists the rules', () => {
    render(<OneNeeds />);
    const review = screen.getAllByRole('button', { name: copy.one.needs.review })[0];
    if (review === undefined) throw new Error('fixture');
    fireEvent.click(review);
    expect(useUiStore.getState().overlays.at(-1)).toMatchObject({ kind: 'sheet', sheet: 'grant' });
    expect(screen.getByRole('region', { name: copy.one.needs.rules })).toBeTruthy();
  });

  it('a project page shows its code and only its tasks', () => {
    const acme = fixtures.ids.project.acmeShop;
    useUiStore.setState({ projectId: acme, screen: 'one-project' });
    render(<OneProject />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('acme-shop');
    expect(screen.getByRole('region', { name: copy.one.project.code })).toBeTruthy();
    const shown = document.querySelectorAll('[data-one-task]').length;
    expect(shown).toBe(oneTasks(model, NOW, acme).length);
  });
});

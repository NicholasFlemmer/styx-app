// @vitest-environment jsdom
import { copy, fixtures, oneNeeds, oneTasks } from '@styx/core';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { OneApps } from './OneApps';
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
    expect(useUiStore.getState().screen).toBe('one-task');
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

  it('Connected apps adds an app by its address and offers Sign in for one that is signed out', () => {
    useReadModel.getState().replaceModel(
      {
        ...model,
        connectedApps: [
          {
            id: 'app1',
            kind: 'mcp' as const,
            account: null,
            currency: null,
            name: 'Linear',
            url: 'https://mcp.linear.app',
            status: 'signed-out',
            error: null,
            tools: [],
            projects: [],
            addedAt: NOW,
            checkedAt: null,
          },
        ],
      },
      'connected',
    );
    useUiStore.setState({ projectId: fixtures.ids.project.acmeShop });
    render(<OneApps />);
    // One click from the catalogue.
    fireEvent.click(screen.getByRole('button', { name: `${copy.one.apps.connectOne} Notion` }));
    expect(commandMock).toHaveBeenCalledWith('connectedApps.add', {
      name: 'Notion',
      url: 'https://mcp.notion.com/mcp',
      projectId: fixtures.ids.project.acmeShop,
    });
    // Add your own opens the address form.
    fireEvent.click(screen.getByRole('button', { name: new RegExp(copy.one.apps.own) }));
    const form = screen.getByRole('form', { name: copy.one.apps.addByUrl });
    fireEvent.change(within(form).getByLabelText(copy.one.apps.nameLabel), { target: { value: 'Ours' } });
    fireEvent.change(within(form).getByLabelText(copy.one.apps.urlLabel), {
      target: { value: 'https://mcp.example.com/mcp' },
    });
    fireEvent.click(within(form).getByRole('button', { name: copy.one.apps.add }));
    expect(commandMock).toHaveBeenCalledWith('connectedApps.add', {
      name: 'Ours',
      url: 'https://mcp.example.com/mcp',
      projectId: fixtures.ids.project.acmeShop,
      clientId: '',
      clientSecret: '',
      issuer: '',
      token: '',
      header: 'Authorization',
    });
    // A signed-out app: Manage, then Sign in or Disconnect.
    fireEvent.click(screen.getByRole('button', { name: `${copy.one.apps.manage} Linear` }));
    fireEvent.click(screen.getByRole('button', { name: copy.one.apps.signIn }));
    expect(commandMock).toHaveBeenCalledWith('connectedApps.signIn', { appId: 'app1' });
    fireEvent.click(screen.getByRole('button', { name: `${copy.one.apps.remove} Linear` }));
    expect(commandMock).toHaveBeenCalledWith('connectedApps.remove', { appId: 'app1' });
  });

  it('a starter fills the ask box, and a campaign brief shows its fields', () => {
    useReadModel
      .getState()
      .replaceModel({ ...model, connectedApps: fixtures.oneFixture().connectedApps }, 'connected');
    render(<OneHome />);
    fireEvent.click(screen.getByRole('button', { name: /Retarget people who visited/ }));
    const box = screen.getByRole('textbox', { name: copy.one.ask }) as HTMLTextAreaElement;
    expect(box.value).toBe('Retarget people who looked at a product and did not buy.');
    expect(screen.getByRole('group', { name: copy.one.brief.label })).toBeTruthy();
    expect(screen.getByLabelText(copy.one.brief.budget)).toBeTruthy();
    // Without Klaviyo connected, its starter is not offered.
    expect(screen.queryByRole('button', { name: /Write this week/ })).toBeNull();
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

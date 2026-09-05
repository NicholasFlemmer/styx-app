// @vitest-environment jsdom
import { copy, fixtures } from '@styx/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { NewProjectModal } from './NewProjectModal';

const acme = fixtures.ids.project.acmeShop;
let sessionId: string | null = 'session-new';
const commandMock = vi.fn(async (name: string) =>
  name === 'project.create'
    ? { ok: true as const, value: { projectId: 'project-new', sessionId } }
    : { ok: true as const, value: {} },
);

describe('NewProjectModal', () => {
  beforeEach(() => {
    commandMock.mockClear();
    sessionId = 'session-new';
    Object.assign(window, {
      styx: { platform: 'darwin', env: { now: fixtures.DEMO_NOW }, command: commandMock },
    });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({
      overlays: [{ id: 'modal-1', kind: 'modal', modal: 'new-project' }],
      screen: 'home',
      platform: 'darwin',
      projectId: acme,
      projectSession: {},
    });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('defaults to the agent tile with the project default agent, GitHub toggle on and the note', () => {
    render(<NewProjectModal id="modal-1" />);
    expect(screen.getByRole('dialog').textContent).toContain(copy.newProject.title);
    const tiles = screen.getAllByRole('radio');
    expect(tiles.map((t) => t.getAttribute('data-inv'))).toEqual([null, null, 'true']);
    expect(screen.getByLabelText('Brief for Claude Code')).toBeTruthy();
    expect(screen.getByText(copy.newProject.agentNote)).toBeTruthy();
    const labels = screen.getAllByRole('checkbox').map((c) => c.closest('label')?.textContent);
    expect(labels).toEqual([
      'git init',
      'Create GitHub repo · private',
      'Copy targets from acme-shop',
      'Open in VS Code too',
    ]);
    expect(screen.getAllByRole('checkbox').map((c) => (c as HTMLInputElement).checked)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(screen.getByText('GitHub acme · persistent grant · repo will be acme/')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create · spawn Claude Code · ⌘⏎' })).toBeTruthy();
  });

  it('name drives the location until it is edited; Create focuses the first missing field', async () => {
    render(<NewProjectModal id="modal-1" />);
    const name = screen.getByLabelText(copy.newProject.name) as HTMLInputElement;
    const location = screen.getByLabelText(copy.newProject.location) as HTMLInputElement;
    const create = screen.getByRole('button', { name: /^Create/ });
    expect(location.value).toBe('~/code/');
    fireEvent.click(create);
    expect(document.activeElement).toBe(name);
    expect(commandMock).not.toHaveBeenCalledWith('project.create', expect.anything());
    fireEvent.change(name, { target: { value: 'orders-service' } });
    expect(location.value).toBe('~/code/orders-service');
    expect(
      screen.getByText('GitHub acme · persistent grant · repo will be acme/orders-service'),
    ).toBeTruthy();
    fireEvent.click(create);
    expect(document.activeElement).toBe(screen.getByLabelText('Brief for Claude Code'));
    expect(commandMock).not.toHaveBeenCalledWith('project.create', expect.anything());
    fireEvent.change(screen.getByLabelText('Brief for Claude Code'), {
      target: { value: 'A TypeScript service.' },
    });
    fireEvent.change(location, { target: { value: '~/work/orders' } });
    fireEvent.change(name, { target: { value: 'orders' } });
    expect(location.value).toBe('~/work/orders');
    expect(screen.getByRole('button', { name: copy.newProject.browse }).hasAttribute('disabled')).toBe(true);

    fireEvent.click(create);
    await waitFor(() => expect(useUiStore.getState().overlays).toHaveLength(0));
    expect(commandMock).toHaveBeenCalledWith('project.create', {
      name: 'orders',
      location: '~/work/orders',
      startFrom: { kind: 'agent', agent: 'claude', brief: 'A TypeScript service.' },
      gitInit: true,
      createGithubRepo: true,
      copyTargetsFrom: null,
      openInIde: false,
    });
    const ui = useUiStore.getState();
    expect(ui.screen).toBe('workspace');
    expect(ui.projectId).toBe('project-new');
    expect(ui.projectSession['project-new']).toBe('session-new');
  });

  it('empty and template starts change the field, label and payload, and land on Home', async () => {
    sessionId = null;
    render(<NewProjectModal id="modal-1" />);
    fireEvent.click(screen.getByRole('radio', { name: /^Template/ }));
    expect(screen.getByLabelText(copy.newProject.templateLabel)).toBeTruthy();
    expect(screen.getByText(copy.newProject.templateNote)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create · ⌘⏎' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(copy.newProject.templateLabel), { target: { value: 'rust' } });
    fireEvent.click(screen.getByRole('radio', { name: /^Empty folder/ }));
    expect(screen.queryByLabelText(copy.newProject.templateLabel)).toBeNull();
    fireEvent.change(screen.getByLabelText(copy.newProject.name), { target: { value: 'blank' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Create GitHub repo · private' }));
    expect(screen.queryByText(/persistent grant/)).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Copy targets from acme-shop' }));
    fireEvent.keyDown(screen.getByLabelText(copy.newProject.name), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(useUiStore.getState().overlays).toHaveLength(0));
    expect(commandMock).toHaveBeenCalledWith('project.create', {
      name: 'blank',
      location: '~/code/blank',
      startFrom: { kind: 'empty' },
      gitInit: true,
      createGithubRepo: false,
      copyTargetsFrom: acme,
      openInIde: false,
    });
    expect(useUiStore.getState().screen).toBe('home');
    expect(useUiStore.getState().projectId).toBe('project-new');
  });

  it('without a GitHub target the row links to the connect modal on GitHub', () => {
    useUiStore.setState({ projectId: fixtures.ids.project.infraTools });
    render(<NewProjectModal id="modal-1" />);
    expect(screen.queryByRole('checkbox', { name: 'Create GitHub repo · private' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: copy.newProject.connectGithub }));
    expect(useUiStore.getState().overlays).toMatchObject([
      { kind: 'modal', modal: 'connect', projectId: fixtures.ids.project.infraTools, provider: 'github' },
    ]);
  });

  it('uses Ctrl wording and C:\\dev on Windows', () => {
    useUiStore.setState({ platform: 'win32' });
    render(<NewProjectModal id="modal-1" />);
    fireEvent.change(screen.getByLabelText(copy.newProject.name), { target: { value: 'svc' } });
    expect((screen.getByLabelText(copy.newProject.location) as HTMLInputElement).value).toBe('C:\\dev\\svc');
    expect(screen.getByRole('button', { name: 'Create · spawn Claude Code · Ctrl⏎' })).toBeTruthy();
  });
});

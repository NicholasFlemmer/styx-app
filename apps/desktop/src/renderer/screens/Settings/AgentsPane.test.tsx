// @vitest-environment jsdom
import { copy, fixtures, type ReadModel } from '@styx/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { AgentsPane } from './AgentsPane';

let resolveVerify: (() => void) | null = null;
const commandMock = vi.fn(async (name: string, _input?: unknown) => {
  if (name === 'agent.verify') {
    await new Promise<void>((resolve) => {
      resolveVerify = resolve;
    });
    return { ok: true as const, value: { cli: fixtures.demoClis()[0] } };
  }
  return { ok: true as const, value: {} };
});
const calls = (name: string) => commandMock.mock.calls.filter((c) => c[0] === name);

const cells = (agent: string) =>
  within(document.querySelector(`[data-agent-row="${agent}"]`) as HTMLElement)
    .getAllByRole('cell')
    .map((c) => c.textContent);

describe('<AgentsPane />', () => {
  beforeEach(() => {
    commandMock.mockClear();
    resolveVerify = null;
    Object.assign(window, {
      styx: { platform: 'darwin', env: { now: fixtures.DEMO_NOW }, command: commandMock },
    });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({ overlays: [], screen: 'settings', platform: 'darwin' });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('lists every agent in prototype order with version, account and connection state', () => {
    render(<AgentsPane />);
    expect(screen.getByText(copy.agentsPage.lead)).toBeTruthy();
    const table = screen.getByRole('table', { name: copy.agentsPage.title });
    const header = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(header).toEqual(['Agent', 'Version', 'Account', 'State', 'Actions']);
    const rows = [...table.querySelectorAll('[data-agent-row]')];
    expect(rows.map((r) => r.getAttribute('data-agent-row'))).toEqual([
      'claude',
      'codex',
      'gemini',
      'cursor',
      'shell',
    ]);
    expect(rows.map((r) => r.getAttribute('data-agent-state'))).toEqual([
      'connected',
      'connected',
      'signed-out',
      'unverified',
      'shell',
    ]);
    expect(cells('claude')).toEqual([
      'Claude Code',
      'claude 2.4.1',
      'nic@acme.dev',
      'connected',
      'VerifyReconnect',
    ]);
    expect(cells('codex')).toEqual(['Codex', 'codex 0.9.3', 'ChatGPT', 'connected', 'VerifyReconnect']);
    expect(cells('gemini')).toEqual(['Gemini CLI', 'gemini 1.2.0', '—', 'signed out', 'VerifyConnect']);
    expect(cells('cursor')).toEqual([
      'Cursor agent',
      'cursor-agent 0.5.2',
      'nic@acme.dev',
      'not verified',
      'VerifyConnect',
    ]);
    expect(cells('shell')).toEqual(['Shell', 'zsh 5.9', '—', 'ready', '']);
    // The onboarding step-3 recipe: a hollow dot that turns accent (`data-on`) when the row needs attention.
    const dot = (agent: string) => document.querySelector(`[data-agent-row="${agent}"] [data-tone]`);
    expect(['claude', 'gemini', 'cursor', 'shell'].map((a) => dot(a)?.getAttribute('data-tone'))).toEqual([
      'hollow',
      'hollow',
      'hollow',
      'hollow',
    ]);
    expect(['claude', 'gemini', 'cursor', 'shell'].map((a) => dot(a)?.getAttribute('data-on'))).toEqual([
      null,
      'true',
      'true',
      null,
    ]);
  });

  it('a missing CLI reads not installed with Connect only; an undetected agent still gets a row', () => {
    const m = fixtures.errorReadModel();
    const clis = m.discovery.clis.filter((c) => c.agent !== 'cursor');
    useReadModel
      .getState()
      .replaceModel({ ...m, discovery: { ...m.discovery, clis } } as ReadModel, 'connected');
    render(<AgentsPane />);
    expect(cells('codex')).toEqual(['Codex', 'not found on PATH', '—', 'not installed', 'Connect']);
    expect(cells('cursor')).toEqual(['Cursor agent', 'not found on PATH', '—', 'not installed', 'Connect']);
    expect(screen.queryByRole('button', { name: /^Verify · Codex/ })).toBeNull();
  });

  it('Verify dispatches agent.verify and reads checking… until it settles', async () => {
    render(<AgentsPane />);
    fireEvent.click(screen.getByRole('button', { name: /^Verify · Gemini CLI/ }));
    expect(calls('agent.verify')).toEqual([['agent.verify', { agent: 'gemini' }]]);
    await waitFor(() => expect(cells('gemini')[3]).toBe(copy.agentsPage.state.checking));
    expect(screen.getByRole('button', { name: /^Verify · Gemini CLI/ }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    // A second click while checking does nothing.
    fireEvent.click(screen.getByRole('button', { name: /^Verify · Gemini CLI/ }));
    expect(calls('agent.verify')).toHaveLength(1);
    resolveVerify?.();
    await waitFor(() => expect(cells('gemini')[3]).toBe(copy.agentsPage.state.signedOut));
  });

  it('a failed check reads check failed', () => {
    const m = fixtures.demoReadModel();
    const clis = m.discovery.clis.map((c) =>
      c.agent === 'codex' ? { ...c, verifyError: 'spawn ENOENT' } : c,
    );
    useReadModel.getState().replaceModel({ ...m, discovery: { ...m.discovery, clis } }, 'connected');
    render(<AgentsPane />);
    expect(cells('codex')[3]).toBe(copy.agentsPage.state.failed);
  });

  it('Connect / Reconnect open the Connect agent modal for that agent', () => {
    render(<AgentsPane />);
    fireEvent.click(screen.getByRole('button', { name: /^Connect · Gemini CLI/ }));
    expect(useUiStore.getState().overlays).toMatchObject([
      { kind: 'modal', modal: 'connect-agent', agent: 'gemini' },
    ]);
    fireEvent.click(screen.getByRole('button', { name: /^Reconnect · Claude Code/ }));
    expect(useUiStore.getState().overlays).toMatchObject([
      { kind: 'modal', modal: 'connect-agent', agent: 'claude' },
    ]);
    expect(useUiStore.getState().overlays).toHaveLength(1);
  });

  it('renders the Preferences label and whatever rows it is handed', () => {
    render(
      <AgentsPane>
        <div data-testid="rows">rows</div>
      </AgentsPane>,
    );
    expect(screen.getByText(copy.agentsPage.preferences)).toBeTruthy();
    expect(screen.getByTestId('rows')).toBeTruthy();
  });
});

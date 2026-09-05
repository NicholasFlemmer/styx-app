// @vitest-environment jsdom
import { copy, fixtures } from '@styx/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { Onboarding } from './Onboarding';
import { repoMeta } from './onboarding-rows';

const YEAR = 365 * 24 * 60 * 60 * 1000;
const scanned = [
  {
    path: '~/code/acme-shop',
    remote: 'git@github.com:acme/shop.git',
    branch: 'main',
    source: 'scan',
    lastModifiedAt: fixtures.DEMO_NOW,
    suggested: true,
  },
  {
    path: '~/work/client-x',
    remote: 'https://gitlab.com/client-x/app',
    branch: 'main',
    source: 'ide-recent',
    lastModifiedAt: fixtures.DEMO_NOW,
    suggested: true,
  },
  {
    path: '~/Downloads/tmp-fork',
    remote: null,
    branch: null,
    source: 'scan',
    lastModifiedAt: fixtures.DEMO_NOW - 2 * YEAR,
    suggested: false,
  },
] as const;

const commandMock = vi.fn(async (name: string, _input?: unknown) =>
  name === 'project.scan'
    ? { ok: true as const, value: { repos: scanned } }
    : { ok: true as const, value: {} },
);

const calls = (name: string) => commandMock.mock.calls.filter((c) => c[0] === name);

describe('Onboarding', () => {
  beforeEach(() => {
    commandMock.mockClear();
    Object.assign(window, {
      styx: { platform: 'darwin', env: { now: fixtures.DEMO_NOW }, command: commandMock },
    });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({
      overlays: [],
      screen: 'onboarding',
      onboardingStep: 1,
      platform: 'darwin',
      projectId: null,
    });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('renders the four-step strip with the current step inverted and detected IDE rows', () => {
    render(<Onboarding />);
    const cells = screen.getAllByRole('listitem');
    expect(cells.map((c) => c.textContent)).toEqual(['01Editor', '02Projects', '03Agents', '04Targets']);
    expect(cells.map((c) => c.getAttribute('data-inv'))).toEqual(['true', null, null, null]);
    expect(screen.getByRole('heading').textContent).toBe(copy.onboarding.editor.headline);
    // Main owns discovery (it re-detects on real profiles at startup); the screen only reads the rows.
    expect(calls('detect.ides')).toHaveLength(0);
    expect(calls('detect.clis')).toHaveLength(0);

    const rows = screen.getByRole('table').querySelectorAll('[data-ide-id]');
    expect(
      [...rows].map((r) =>
        within(r as HTMLElement)
          .getAllByRole('cell')
          .map((c) => c.textContent),
      ),
    ).toEqual([
      ['', 'VS Code', '1.98 · /Applications', '14 recents · keybindings · theme', 'Fallback · Open in'],
      ['', 'Cursor', '1.4', '6 recents · keybindings', 'Detected'],
      ['', 'JetBrains (WebStorm)', '2026.2', '3 recents', 'Detected'],
      ['', 'Neovim', '0.11 · /opt/homebrew', 'recents via shada', 'Detected'],
    ]);
    expect(rows[0]?.querySelector('[data-tone], [data-on]')?.getAttribute('data-on')).toBe('true');
    expect(
      screen
        .getByRole('checkbox', { name: 'VS Code' })
        .closest('[role=row]')
        ?.querySelector('[data-inv="true"]'),
    ).toBeTruthy();
    // Picking Cursor moves the role tag and the accent box.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Cursor' }));
    expect(rows[1]?.textContent).toContain('Fallback · Open in');
    expect(rows[0]?.textContent).toContain('Detected');
    expect(
      screen
        .getAllByRole('checkbox')
        .slice(4)
        .map((c) => (c as HTMLInputElement).checked),
    ).toEqual([true, true, true, false]);
  });

  it('Continue on Editor sets the fallback, imports the checked items and installs Open in Styx only when checked', async () => {
    render(<Onboarding />);
    fireEvent.click(screen.getByRole('checkbox', { name: copy.onboarding.editor.importTheme }));
    fireEvent.click(screen.getByRole('button', { name: copy.onboarding.footer.continue }));
    await waitFor(() => expect(useUiStore.getState().onboardingStep).toBe(2));
    expect(commandMock).toHaveBeenCalledWith('ide.setFallback', { kind: 'vscode' });
    expect(commandMock).toHaveBeenCalledWith('ide.import', {
      ideId: 'ide-vscode',
      keybindings: true,
      theme: false,
      recents: true,
    });
    expect(calls('ide.installOpenIn')).toHaveLength(0);
    expect(commandMock).toHaveBeenCalledWith('project.scan', { includeIdeRecents: true });
  });

  it('Editor: Install "Open in Styx" runs when checked', async () => {
    render(<Onboarding />);
    fireEvent.click(screen.getByRole('checkbox', { name: copy.onboarding.editor.installOpenIn }));
    fireEvent.click(screen.getByRole('button', { name: copy.onboarding.footer.continue }));
    await waitFor(() => expect(calls('ide.installOpenIn')).toHaveLength(1));
  });

  it('Projects: lists scanned repos, unchecked when not suggested, adds only the checked ones', async () => {
    useUiStore.setState({ onboardingStep: 2 });
    render(<Onboarding />);
    await screen.findByText('Found 3 repos on this machine.');
    expect(
      screen.getByText(
        'Pick the ones Styx should manage. VS Code recents and workspaces are included. Nothing is modified.',
      ),
    ).toBeTruthy();
    const rows = screen.getByRole('table').querySelectorAll('[data-repo-path]');
    expect(
      [...rows].map((r) =>
        within(r as HTMLElement)
          .getAllByRole('cell')
          .map((c) => c.textContent),
      ),
    ).toEqual([
      ['', '~/code/acme-shop', 'github · main'],
      ['', '~/work/client-x', 'gitlab · main'],
      ['', '~/Downloads/tmp-fork', 'no remote · 2y old'],
    ]);
    expect(screen.getAllByRole('checkbox').map((c) => (c as HTMLInputElement).checked)).toEqual([
      true,
      true,
      false,
    ]);
    fireEvent.click(screen.getByRole('checkbox', { name: '~/work/client-x' }));
    fireEvent.click(screen.getByRole('button', { name: copy.onboarding.projects.addRow }));
    expect(useUiStore.getState().overlays).toMatchObject([{ kind: 'modal', modal: 'new-project' }]);
    fireEvent.click(screen.getByRole('button', { name: copy.onboarding.footer.continue }));
    await waitFor(() => expect(useUiStore.getState().onboardingStep).toBe(3));
    expect(calls('project.add').map((c) => c[1])).toEqual([{ path: '~/code/acme-shop' }]);
  });

  it('Agents: rows show version, auth state and an accent dot only for missing CLIs; Continue just advances', async () => {
    useReadModel.getState().replaceModel(fixtures.errorReadModel(), 'connected');
    useUiStore.setState({ onboardingStep: 3 });
    render(<Onboarding />);
    expect(screen.getByRole('heading').textContent).toBe(copy.onboarding.agents.headline);
    const rows = screen.getByRole('table').querySelectorAll('[data-agent]');
    expect(
      [...rows].map((r) =>
        within(r as HTMLElement)
          .getAllByRole('cell')
          .map((c) => c.textContent),
      ),
    ).toEqual([
      ['Claude Code', 'claude 2.4.1', 'signed in', ''],
      ['Codex', 'not found on PATH', 'Install →', ''],
      ['Gemini CLI', 'gemini 1.2.0', 'Sign in →', ''],
      ['Cursor agent', 'cursor-agent 0.5.2', 'signed in', ''],
      ['Shell', 'zsh 5.9', '—', ''],
    ]);
    const dots = [...rows].map((r) => r.querySelector('[data-tone="hollow"]')?.getAttribute('data-on'));
    expect(dots).toEqual([null, 'true', null, null, null]);
    const before = commandMock.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: copy.onboarding.footer.continue }));
    await waitFor(() => expect(useUiStore.getState().onboardingStep).toBe(4));
    expect(commandMock.mock.calls.length).toBe(before);
  });

  it('Targets: six provider tiles open the connect modal on that provider; Finish completes onboarding', async () => {
    useUiStore.setState({ onboardingStep: 4 });
    render(<Onboarding />);
    expect(screen.getByText(/macOS Keychain/)).toBeTruthy();
    const tiles = screen.getByRole('heading').parentElement?.querySelectorAll('[data-provider]') ?? [];
    expect([...tiles].map((t) => t.textContent)).toEqual([
      'VercelOAuth · connect →',
      'AWSIAM / key · connect →',
      'GCPIAM / key · connect →',
      'SupabaseOAuth · connect →',
      'GitHubOAuth · connect →',
      'SSH hostSSH · connect →',
    ]);
    fireEvent.click(screen.getByRole('button', { name: /^AWS/ }));
    expect(useUiStore.getState().overlays).toMatchObject([
      { kind: 'modal', modal: 'connect', projectId: null, provider: 'aws' },
    ]);
    fireEvent.click(screen.getByRole('button', { name: copy.onboarding.footer.finish }));
    await waitFor(() => expect(useUiStore.getState().screen).toBe('home'));
    expect(commandMock).toHaveBeenCalledWith('onboarding.complete', {});
  });

  it('Back steps back (no-op on step 1); Skip completes onboarding from any step', async () => {
    useUiStore.setState({ onboardingStep: 3 });
    render(<Onboarding />);
    fireEvent.click(screen.getByRole('button', { name: copy.onboarding.footer.back }));
    expect(useUiStore.getState().onboardingStep).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: copy.onboarding.footer.back }));
    fireEvent.click(screen.getByRole('button', { name: copy.onboarding.footer.back }));
    expect(useUiStore.getState().onboardingStep).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: copy.onboarding.footer.skip }));
    await waitFor(() => expect(useUiStore.getState().screen).toBe('home'));
    expect(commandMock).toHaveBeenCalledWith('onboarding.complete', {});
  });

  it('repoMeta formats prototype strings', () => {
    expect(repoMeta({ ...scanned[0], remote: 'https://github.com/acme/shop' }, fixtures.DEMO_NOW)).toBe(
      'github · main',
    );
    expect(repoMeta({ ...scanned[0], remote: 'git@gitlab.com:x/y.git', branch: null }, fixtures.DEMO_NOW)).toBe(
      'gitlab',
    );
    expect(repoMeta(scanned[2], fixtures.DEMO_NOW)).toBe('no remote · 2y old');
    expect(repoMeta({ ...scanned[2], lastModifiedAt: fixtures.DEMO_NOW }, fixtures.DEMO_NOW)).toBe('no remote');
  });
});

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
    hasGit: true,
    source: 'scan',
    lastModifiedAt: fixtures.DEMO_NOW,
    suggested: true,
  },
  {
    path: '~/work/client-x',
    remote: 'https://gitlab.com/client-x/app',
    branch: 'main',
    hasGit: true,
    source: 'ide-recent',
    lastModifiedAt: fixtures.DEMO_NOW,
    suggested: true,
  },
  {
    path: '~/Downloads/tmp-fork',
    remote: null,
    branch: null,
    hasGit: true,
    source: 'scan',
    lastModifiedAt: fixtures.DEMO_NOW - 2 * YEAR,
    suggested: false,
  },
] as const;

/** Rows from the agent CLIs' own history (#93): a repo Claude Code worked in, a plain folder Codex worked in. */
const agentScanned = [
  {
    path: '~/code/from-claude',
    remote: 'git@github.com:acme/from-claude.git',
    branch: 'main',
    hasGit: true,
    source: 'claude',
    lastModifiedAt: fixtures.DEMO_NOW,
    suggested: true,
  },
  {
    path: '~/notes',
    remote: null,
    branch: null,
    hasGit: false,
    source: 'codex',
    lastModifiedAt: fixtures.DEMO_NOW,
    suggested: true,
  },
] as const;

let picked: string | null = '/Users/me/PBX';
let scannedRows: readonly (typeof scanned)[number][] | readonly (typeof agentScanned)[number][] = scanned;
const commandMock = vi.fn(async (name: string, _input?: unknown) => {
  if (name === 'project.scan') return { ok: true as const, value: { repos: scannedRows } };
  if (name === 'dialog.pickFolder') return { ok: true as const, value: { path: picked } };
  return { ok: true as const, value: {} };
});

const calls = (name: string) => commandMock.mock.calls.filter((c) => c[0] === name);

describe('Onboarding', () => {
  beforeEach(() => {
    commandMock.mockClear();
    picked = '/Users/me/PBX';
    scannedRows = scanned;
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

  it('lists the four steps down the side, each with why it matters, the current one marked, and detected IDE rows', () => {
    render(<Onboarding />);
    const cells = within(screen.getByRole('list', { name: copy.onboarding.stepsLabel })).getAllByRole(
      'listitem',
    );
    expect(cells.map((c) => c.textContent)).toEqual([
      `1${copy.onboarding.stepTitles.editor}${copy.onboarding.stepWhy.editor}`,
      `2${copy.onboarding.stepTitles.projects}${copy.onboarding.stepWhy.projects}`,
      `3${copy.onboarding.stepTitles.agents}${copy.onboarding.stepWhy.agents}`,
      `4${copy.onboarding.stepTitles.targets}${copy.onboarding.stepWhy.targets}`,
    ]);
    expect(cells.map((c) => c.getAttribute('data-state'))).toEqual(['now', 'next', 'next', 'next']);
    expect(cells[0]?.getAttribute('aria-current')).toBe('step');
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
    ).toEqual([true, true, true, true, false]);
  });

  it('Editor: every detected editor kind gets its own row (Windsurf and Zed included)', () => {
    const m = fixtures.demoReadModel();
    const vscode = m.discovery.ides[0];
    if (!vscode) throw new Error('demo fixture has no IDE rows');
    const extra = (id: string, kind: 'windsurf' | 'zed', product: string) => ({
      ...vscode,
      id,
      kind,
      product,
      isFallback: false,
      recentsSource: kind === 'zed' ? null : ('state-db' as const),
    });
    useReadModel.getState().replaceModel(
      {
        ...m,
        discovery: {
          ...m.discovery,
          ides: [
            ...m.discovery.ides,
            extra('ide-windsurf', 'windsurf', 'Windsurf'),
            extra('ide-zed', 'zed', 'Zed'),
          ],
        },
      },
      'connected',
    );
    render(<Onboarding />);
    expect(
      [...screen.getByRole('table').querySelectorAll('[data-ide-id]')].map((r) =>
        r.getAttribute('data-ide-id'),
      ),
    ).toEqual(['ide-vscode', 'ide-cursor', 'ide-webstorm', 'ide-neovim', 'ide-windsurf', 'ide-zed']);
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
    expect(commandMock).toHaveBeenCalledWith('project.scan', {
      includeIdeRecents: true,
      includeAgentHistory: true,
    });
  });

  it('Editor: "Also look where Claude Code and Codex have worked" is on by default; unchecked, step 2 scans without agent history', async () => {
    render(<Onboarding />);
    const toggle = screen.getByRole('checkbox', { name: copy.onboarding.editor.importAgentDirs });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: copy.onboarding.footer.continue }));
    await waitFor(() => expect(useUiStore.getState().onboardingStep).toBe(2));
    expect(commandMock).toHaveBeenCalledWith('project.scan', {
      includeIdeRecents: true,
      includeAgentHistory: false,
    });
    // It is not an IDE import.
    expect(calls('ide.import')[0]?.[1]).toEqual({
      ideId: 'ide-vscode',
      keybindings: true,
      theme: true,
      recents: true,
    });
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
      ['', '~/work/client-x', 'gitlab · main · editor recents'],
      ['', '~/Downloads/tmp-fork', 'no remote · 2y old'],
    ]);
    expect(screen.getAllByRole('checkbox').map((c) => (c as HTMLInputElement).checked)).toEqual([
      true,
      true,
      false,
    ]);
    fireEvent.click(screen.getByRole('checkbox', { name: '~/work/client-x' }));
    // The add row renders the §10 string as three actions.
    const addRow = screen.getByText((_, el) => el?.hasAttribute('data-onboarding-add-row') === true);
    expect(addRow.textContent).toBe(copy.onboarding.projects.addRow);
    fireEvent.click(screen.getByRole('button', { name: copy.onboarding.projects.addRowNew }));
    expect(useUiStore.getState().overlays).toMatchObject([{ kind: 'modal', modal: 'new-project' }]);
    expect(useUiStore.getState().overlays[0]).not.toHaveProperty('mode');
    useUiStore.setState({ overlays: [] });
    fireEvent.click(screen.getByRole('button', { name: copy.onboarding.projects.addRowClone }));
    expect(useUiStore.getState().overlays).toMatchObject([
      { kind: 'modal', modal: 'new-project', mode: 'clone' },
    ]);
    useUiStore.setState({ overlays: [] });
    fireEvent.click(screen.getByRole('button', { name: copy.onboarding.footer.continue }));
    await waitFor(() => expect(useUiStore.getState().onboardingStep).toBe(3));
    expect(calls('project.add').map((c) => c[1])).toEqual([{ path: '~/code/acme-shop' }]);
  });

  it("Projects: rows from the agent CLIs' history name the CLI in the meta; a plain folder reads no git", async () => {
    scannedRows = agentScanned;
    useUiStore.setState({ onboardingStep: 2 });
    render(<Onboarding />);
    await screen.findByText('Found 2 repos on this machine.');
    const rows = [...screen.getByRole('table').querySelectorAll('[data-repo-path]')];
    expect(rows.map((r) => r.getAttribute('data-repo-source'))).toEqual(['claude', 'codex']);
    expect(
      rows.map((r) =>
        within(r as HTMLElement)
          .getAllByRole('cell')
          .map((c) => c.textContent),
      ),
    ).toEqual([
      ['', '~/code/from-claude', `github · main · ${copy.agentProducts.claude}`],
      ['', '~/notes', `${copy.workspace.noGit} · ${copy.agentProducts.codex}`],
    ]);
  });

  it('Projects: "add folder" picks a folder via main, lists it checked (meta —) and adds it on Continue; dismissed = nothing', async () => {
    useUiStore.setState({ onboardingStep: 2 });
    render(<Onboarding />);
    await screen.findByText('Found 3 repos on this machine.');
    fireEvent.click(screen.getByRole('button', { name: copy.onboarding.projects.addRowFolder }));
    await screen.findByText('Found 4 repos on this machine.');
    const row = screen.getByRole('table').querySelector('[data-repo-path="/Users/me/PBX"]');
    if (row === null) throw new Error('picked row missing');
    expect(
      within(row as HTMLElement)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['', '/Users/me/PBX', '—']);
    expect((screen.getByRole('checkbox', { name: '/Users/me/PBX' }) as HTMLInputElement).checked).toBe(true);
    // Picking the same folder again neither duplicates nor unchecks it.
    fireEvent.click(screen.getByRole('button', { name: copy.onboarding.projects.addRowFolder }));
    await waitFor(() => expect(calls('dialog.pickFolder')).toHaveLength(2));
    expect(screen.getByRole('table').querySelectorAll('[data-repo-path="/Users/me/PBX"]')).toHaveLength(1);
    picked = null;
    fireEvent.click(screen.getByRole('button', { name: copy.onboarding.projects.addRowFolder }));
    await waitFor(() => expect(calls('dialog.pickFolder')).toHaveLength(3));
    expect(screen.getByText('Found 4 repos on this machine.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: copy.onboarding.footer.continue }));
    await waitFor(() => expect(useUiStore.getState().onboardingStep).toBe(3));
    expect(calls('project.add').map((c) => c[1])).toEqual([
      { path: '/Users/me/PBX' },
      { path: '~/code/acme-shop' },
      { path: '~/work/client-x' },
    ]);
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
    // "Sign in →" / "Install →" are real buttons (owner addition): they open the Connect agent modal for that CLI.
    expect(
      [...rows].map((r) => r.querySelector('[data-agent-connect]')?.getAttribute('data-agent-connect')),
    ).toEqual([undefined, 'codex', 'gemini', undefined, undefined]);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in → · Gemini CLI' }));
    expect(useUiStore.getState().overlays).toMatchObject([
      { kind: 'modal', modal: 'connect-agent', agent: 'gemini' },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Install → · Codex' }));
    expect(useUiStore.getState().overlays).toMatchObject([
      { kind: 'modal', modal: 'connect-agent', agent: 'codex' },
    ]);
    expect(useUiStore.getState().overlays).toHaveLength(1);
    useUiStore.setState({ overlays: [] });
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
      'Vercelvercel CLI · connect →',
      'AWSaws CLI · connect →',
      'GCPgcloud CLI · connect →',
      'Supabasesupabase CLI · connect →',
      'GitHubgh CLI · connect →',
      'SSH hostSSH · connect →',
    ]);
    fireEvent.click(screen.getByRole('button', { name: /^AWS/ }));
    expect(useUiStore.getState().overlays).toMatchObject([
      { kind: 'modal', modal: 'connect', projectId: null, provider: 'aws' },
    ]);
    fireEvent.click(screen.getByRole('button', { name: copy.onboarding.footer.finish }));
    // With a project to work in, finishing lands on New task in it (ADR-0027 §1).
    await waitFor(() => expect(useUiStore.getState().screen).toBe('workspace'));
    expect(useUiStore.getState().newTask).not.toBeNull();
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
    await waitFor(() => expect(useUiStore.getState().screen).toBe('workspace'));
    expect(commandMock).toHaveBeenCalledWith('onboarding.complete', {});
  });

  it('with no project yet, finishing goes to All projects', async () => {
    useReadModel.getState().replaceModel(fixtures.emptyReadModel(), 'connected');
    useUiStore.setState({ onboardingStep: 4, newTask: null });
    render(<Onboarding />);
    fireEvent.click(screen.getByRole('button', { name: copy.onboarding.footer.skip }));
    await waitFor(() => expect(useUiStore.getState().screen).toBe('home'));
    expect(useUiStore.getState().newTask).toBeNull();
  });

  it('repoMeta formats prototype strings', () => {
    expect(repoMeta({ ...scanned[0], remote: 'https://github.com/acme/shop' }, fixtures.DEMO_NOW)).toBe(
      'github · main',
    );
    expect(
      repoMeta({ ...scanned[0], remote: 'git@gitlab.com:x/y.git', branch: null }, fixtures.DEMO_NOW),
    ).toBe('gitlab');
    expect(repoMeta(scanned[2], fixtures.DEMO_NOW)).toBe('no remote · 2y old');
    expect(
      repoMeta({ ...scanned[2], hasGit: false, lastModifiedAt: fixtures.DEMO_NOW }, fixtures.DEMO_NOW),
    ).toBe('no git');
    expect(repoMeta({ ...scanned[2], lastModifiedAt: fixtures.DEMO_NOW }, fixtures.DEMO_NOW)).toBe(
      'no remote',
    );
  });
});

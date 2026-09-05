// @vitest-environment jsdom
import { copy, fixtures } from '@styx/core';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { sectionRows } from './rows';
import { resolveSection } from './sections';
import { Settings } from './Settings';

vi.mock('../../state/commands', () => ({ command: vi.fn(async () => ({ ok: true })) }));
const { command } = await import('../../state/commands');
const commandMock = vi.mocked(command);

const acme = fixtures.ids.project.acmeShop;

const seed = (model = fixtures.demoReadModel()) => {
  useReadModel.getState().replaceModel(model, 'fixture');
  useUiStore.setState({ projectId: acme, settingsSection: 'general', overlays: [], platform: 'darwin' });
};

describe('sections', () => {
  it('falls back to Targets (prototype initial state) for unknown ids', () => {
    expect(resolveSection('general')).toBe('project:targets');
    expect(resolveSection('app:general')).toBe('app:general');
  });
});

describe('sectionRows', () => {
  const model = fixtures.demoReadModel();
  const ctx = { projectId: acme, platform: 'darwin' as const };

  it('shortcuts come from core formatChord per platform', () => {
    const mac = sectionRows(model, 'app:shortcuts', ctx).map((r) => r.value);
    expect(mac).toEqual(['⌘K', '⌘P', '⌘1–4', '⌘⏎ / ⌘⌫']);
    const win = sectionRows(model, 'app:shortcuts', { ...ctx, platform: 'win32' }).map((r) => r.value);
    expect(win).toEqual(['Ctrl+K', 'Ctrl+P', 'Ctrl+1–4', 'Ctrl+Enter / Ctrl+Backspace']);
  });

  it('keychain rows use platform words', () => {
    const [store, mfa] = sectionRows(model, 'app:keychain', ctx);
    expect(store?.value).toBe('macOS Keychain');
    expect(mfa?.value).toBe('Touch ID');
    const [winStore, winMfa] = sectionRows(model, 'app:keychain', { ...ctx, platform: 'win32' });
    expect(winStore?.value).toBe('Windows Credential Manager');
    expect(winMfa?.value).toBe('Windows Hello');
  });

  it('detected CLIs and fallback editor come from discovery', () => {
    const clis = sectionRows(model, 'app:agents', ctx).find((r) => r.id === 'detectedClis');
    expect(clis?.value).toBe('claude, codex, gemini, cursor');
    const fallback = sectionRows(model, 'app:editor', ctx).find((r) => r.id === 'fallbackEditor');
    expect(fallback?.value).toBe('vscode');
    expect(fallback?.options.map((o) => o.label)).toContain('VS Code');
  });

  it('project rows mark `source === "project"` keys as overridden', () => {
    const rows = sectionRows(model, 'project:agent-defaults', ctx);
    expect(rows.map((r) => [r.id, r.overridden])).toEqual([
      ['defaultAgent', true],
      ['model', false],
      ['autoApproveEdits', false],
    ]);
  });

  it('prototype values match settingsRowsMap', () => {
    const values = (section: Parameters<typeof sectionRows>[1]) =>
      sectionRows(model, section, ctx).map((r) => r.options.find((o) => o.value === r.value)?.label);
    expect(values('app:general')).toEqual(['System', 'Badge + sound', 'On']);
    expect(values('app:editor')).toEqual(['Monaco (embedded)', 'Styx', 'VS Code', 'Per repo']);
    expect(values('app:agents')).toEqual([
      'Claude Code',
      'On',
      'PowerShell',
      'claude, codex, gemini, cursor',
    ]);
    expect(values('app:keychain')).toEqual(['macOS Keychain', 'Touch ID', 'Scoped token, else env']);
    // Demo fixture mirrors the prototype policies strip (`[false, true, true]`): staging reads are off.
    expect(values('app:policies')).toEqual(['Off', '1 hour', 'JSON']);
    expect(values('project:agent-defaults')).toEqual(['Claude Code', 'Default', 'Off']);
    expect(values('project:env')).toEqual(['Keychain', 'Per grant', '.styx/project.json']);
  });
});

describe('<Settings />', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(fixtures.DEMO_NOW);
    commandMock.mockClear();
    seed();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('opens on Targets with the project scope and the five acme-shop rows', () => {
    render(<Settings />);
    expect(screen.getByRole('heading', { name: 'Targets' })).toBeTruthy();
    expect(screen.getByText('project · acme-shop')).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Targets' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('open · 58m left'),
      expect.stringContaining('persistent'),
      expect.stringContaining('locked'),
      expect.stringContaining('locked'),
      expect.stringContaining('persistent'),
    ]);
    // core `revokable`: open grants and `always`-grant-backed persistent rows offer Revoke (Vercel prod + preview).
    expect(screen.getByRole('button', { name: /^Revoke · Vercel prod/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Revoke · Vercel preview/ })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Edit · / })).toHaveLength(3);
  });

  it('policy select dispatches target.setPolicy', () => {
    render(<Settings />);
    const select = screen.getByRole('combobox', { name: 'Policy · Supabase prod' });
    fireEvent.change(select, { target: { value: 'always' } });
    expect(commandMock).toHaveBeenCalledWith('target.setPolicy', {
      targetId: fixtures.ids.target.supabaseProd,
      policy: 'always',
    });
  });

  it('Revoke revokes the open grant; Edit opens the connect modal', () => {
    render(<Settings />);
    fireEvent.click(screen.getByRole('button', { name: /^Revoke · Vercel prod/ }));
    expect(commandMock).toHaveBeenCalledWith('grant.revoke', {
      grantId: fixtures.ids.grant.vercelProdClaude,
      triggeredBy: 'settings',
    });
    fireEvent.click(screen.getByRole('button', { name: /^Edit · AWS acme-prod/ }));
    expect(useUiStore.getState().overlays).toEqual([
      expect.objectContaining({ kind: 'modal', modal: 'connect', projectId: acme }),
    ]);
  });

  it('+ Connect target opens the connect modal', () => {
    render(<Settings />);
    fireEvent.click(screen.getByRole('button', { name: copy.targets.connectRow }));
    expect(useUiStore.getState().overlays).toEqual([
      expect.objectContaining({ kind: 'modal', modal: 'connect', projectId: acme }),
    ]);
  });

  it('shows the verbatim empty copy when the project has no targets', () => {
    seed(fixtures.emptyReadModel());
    useUiStore.setState({ projectId: null });
    render(<Settings />);
    expect(screen.getByText(copy.empty.targets)).toBeTruthy();
    expect(screen.getByText('project · No project')).toBeTruthy();
    expect(screen.getByText('Project · No project')).toBeTruthy();
  });

  it('nav switches sections; app sections carry the app scope', () => {
    render(<Settings />);
    fireEvent.click(screen.getByRole('button', { name: 'General' }));
    expect(useUiStore.getState().settingsSection).toBe('app:general');
    expect(screen.getByRole('heading', { name: 'General' })).toBeTruthy();
    expect(screen.getByText('app')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('page');

    fireEvent.change(screen.getByRole('combobox', { name: 'Theme' }), { target: { value: 'dark' } });
    expect(commandMock).toHaveBeenCalledWith('settings.set', { patch: { theme: 'dark' } });
  });

  it('project rows: change → project.settings.set, Reset → project.settings.reset', () => {
    render(<Settings />);
    fireEvent.click(screen.getByRole('button', { name: 'Agent defaults' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Auto-approve edits' }), {
      target: { value: 'on' },
    });
    expect(commandMock).toHaveBeenCalledWith('project.settings.set', {
      projectId: acme,
      patch: { autoApproveEdits: true },
    });
    const resets = screen.getAllByRole('button', { name: 'Reset' });
    expect(resets).toHaveLength(1);
    fireEvent.click(resets[0] as HTMLElement);
    expect(commandMock).toHaveBeenCalledWith('project.settings.reset', {
      projectId: acme,
      key: 'defaultAgent',
    });
  });

  it('footer names the committed file', () => {
    render(<Settings />);
    const nav = screen.getByRole('navigation', { name: copy.nav.settings });
    expect(nav.textContent).toContain(copy.settings.footer.file);
    expect(nav.textContent).toContain(copy.settings.footer.note);
  });
});

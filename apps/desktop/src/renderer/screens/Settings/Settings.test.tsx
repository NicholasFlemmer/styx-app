// @vitest-environment jsdom
import { copy, fixtures } from '@styx/core';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
  const ctx = { projectId: acme, platform: 'darwin' as const, copyPlatform: 'darwin' as const };

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
    const [winStore, winMfa] = sectionRows(model, 'app:keychain', { ...ctx, copyPlatform: 'win32' });
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

  it('Detected CLIs shows version · source, and a per-CLI Select appears when alternatives exist', () => {
    const ext =
      '/Users/nic/.vscode/extensions/anthropic.claude-code-2.1.261-darwin-arm64/resources/native-binary/claude';
    const local = '/Users/nic/.local/bin/claude';
    const m = fixtures.demoReadModel();
    const clis = m.discovery.clis.map((c) =>
      c.agent === 'claude'
        ? {
            ...c,
            binary: ext,
            version: '2.1.261',
            capabilities: {
              streamJson: true,
              source: 'vscode-extension',
              alternatives: [
                { binary: local, version: '2.1.199', source: 'path' },
                { binary: ext, version: '2.1.261', source: 'vscode-extension' },
              ],
            },
          }
        : c,
    );
    const rows = sectionRows({ ...m, discovery: { ...m.discovery, clis } }, 'app:agents', ctx);
    expect(rows.find((r) => r.id === 'detectedClis')?.value).toBe(
      'claude 2.1.261 · VS Code extension, codex, gemini, cursor',
    );
    const pick = rows.find((r) => r.id === 'cliBinary:claude');
    expect(pick).toMatchObject({
      label: 'Claude Code binary',
      value: ext,
      change: { kind: 'cli-binary', agent: 'claude' },
    });
    expect(pick?.options.map((o) => o.label)).toEqual([
      'claude 2.1.199 · PATH',
      'claude 2.1.261 · VS Code extension',
    ]);
    // Only one candidate → no Select row.
    expect(sectionRows(model, 'app:agents', ctx).some((r) => r.id.startsWith('cliBinary:'))).toBe(false);
  });

  it('project rows mark `source === "project"` keys as overridden', () => {
    const rows = sectionRows(model, 'project:agent-defaults', ctx);
    expect(rows.map((r) => [r.id, r.overridden])).toEqual([
      ['defaultAgent', true],
      ['model', false],
      ['autoApproveEdits', false],
      ['permissionMode', false],
      ['effort', false],
    ]);
  });

  it('Agent defaults: Model lists the CLI aliases; Permission mode / Effort rows patch project settings (discrepancy #54)', () => {
    const rows = sectionRows(model, 'project:agent-defaults', ctx);
    const modelRow = rows.find((r) => r.id === 'model');
    expect(modelRow?.options.map((o) => [o.value, o.label])).toEqual([
      ['default', 'Default'],
      ['fable', 'Fable'],
      ['opus', 'Opus'],
      ['sonnet', 'Sonnet'],
      ['haiku', 'Haiku'],
    ]);
    const mode = rows.find((r) => r.id === 'permissionMode');
    expect(mode?.value).toBe('default');
    expect(mode?.options.map((o) => o.label)).toEqual([
      'Ask each time',
      'Accept edits',
      'Plan mode',
      'Bypass permissions',
      "Don't ask",
      'Auto',
    ]);
    expect(mode?.change.kind === 'project' && mode.change.patch('plan')).toEqual({ permissionMode: 'plan' });
    expect(mode?.change.kind === 'project' && mode.change.patch('bogus')).toEqual({
      permissionMode: 'default',
    });
    const effort = rows.find((r) => r.id === 'effort');
    expect(effort?.value).toBe('default');
    expect(effort?.options.map((o) => o.value)).toEqual(['default', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(effort?.change.kind === 'project' && effort.change.patch('xhigh')).toEqual({ effort: 'xhigh' });
    expect(effort?.change.kind === 'project' && effort.change.patch('default')).toEqual({ effort: null });
    expect(modelRow?.change.kind === 'project' && modelRow.change.patch('opus')).toEqual({ model: 'opus' });
    // A full model name from project.json stays selectable as an extra option.
    const eff = model.settings.project[acme];
    if (eff === undefined) throw new Error('fixture');
    const custom = {
      ...model,
      settings: {
        ...model.settings,
        project: {
          ...model.settings.project,
          [acme]: { ...eff, model: { value: 'claude-opus-4-1', source: 'project' as const } },
        },
      },
    };
    const customRow = sectionRows(custom, 'project:agent-defaults', ctx).find((r) => r.id === 'model');
    expect(customRow?.value).toBe('claude-opus-4-1');
    expect(customRow?.options.at(-1)).toEqual({ value: 'claude-opus-4-1', label: 'claude-opus-4-1' });
    expect(customRow?.overridden).toBe(true);
  });

  it('prototype values match settingsRowsMap', () => {
    const values = (section: Parameters<typeof sectionRows>[1]) =>
      sectionRows(model, section, ctx).map((r) => r.options.find((o) => o.value === r.value)?.label);
    expect(values('app:general')).toEqual(['System', 'Badge + sound', 'On']);
    expect(values('app:editor')).toEqual(['Monaco (embedded)', 'Styx', 'VS Code', 'Per repo', 'Off']);
    expect(values('app:agents')).toEqual([
      'Claude Code',
      'On',
      'PowerShell',
      'claude, codex, gemini, cursor',
    ]);
    expect(values('app:keychain')).toEqual(['macOS Keychain', 'Touch ID', 'Scoped token, else env']);
    // Demo fixture mirrors the prototype policies strip (`[false, true, true]`): staging reads are off.
    expect(values('app:policies')).toEqual(['Off', '1 hour', 'JSON']);
    expect(values('project:agent-defaults')).toEqual([
      'Claude Code',
      'Default',
      'Off',
      'Ask each time',
      'Default effort',
    ]);
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
    // core `revokable`: only the open (timed) grant offers Revoke; persistent rows read Edit like the prototype.
    expect(screen.getByRole('button', { name: /^Revoke · Vercel prod/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Revoke · Vercel preview/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Edit · / })).toHaveLength(4);
  });

  it('Accept project policies shows for a project-policy banner and dispatches project.policy.accept (security H-1)', () => {
    render(<Settings />);
    expect(screen.queryByRole('button', { name: copy.targets.acceptProjectPolicies })).toBeNull();
    const text = "acme-shop's .styx/project.json wants to change grant policies. Review in Settings.";
    act(() => {
      useUiStore.getState().setBanner({
        bannerKey: `project-policy:${acme}`,
        kind: 'project-policy',
        text,
        cta: copy.errors.projectPolicyUntrusted.cta,
        action: { kind: 'review-project-policy', projectId: acme, hash: 'sha256:abc' },
        sessionId: null,
        reason: null,
      });
    });
    expect(screen.getByRole('status').textContent).toContain(text);
    fireEvent.click(screen.getByRole('button', { name: copy.targets.acceptProjectPolicies }));
    expect(commandMock).toHaveBeenCalledWith('project.policy.accept', {
      projectId: acme,
      hash: 'sha256:abc',
    });
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

  it('Edit reopens the connect modal on that target', () => {
    render(<Settings />);
    fireEvent.click(screen.getByRole('button', { name: /^Edit · AWS acme-prod/ }));
    expect(useUiStore.getState().overlays).toMatchObject([
      {
        kind: 'modal',
        modal: 'connect',
        projectId: acme,
        provider: 'aws',
        targetId: fixtures.ids.target.awsProd,
      },
    ]);
  });

  it('cli targets show `via <cli> · <account>` under the state and a Refresh action (target.refresh)', () => {
    const m = fixtures.demoReadModel();
    const aws = m.targets.byId[fixtures.ids.target.awsProd];
    if (aws === undefined) throw new Error('no aws target');
    seed({
      ...m,
      targets: {
        ...m.targets,
        byId: {
          ...m.targets.byId,
          [aws.id]: { ...aws, authMethod: 'cli', config: { account: 'acme-prod' } },
        },
      },
    });
    render(<Settings />);
    const row = screen.getByRole('table', { name: 'Targets' }).querySelector(`[data-target-id="${aws.id}"]`);
    expect(row?.textContent).toContain('via aws · acme-prod');
    expect(row?.querySelector('[data-target-meta="cli"]')?.textContent).toBe('via aws · acme-prod');
    expect(screen.getAllByRole('button', { name: /^Refresh · / })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /^Refresh · AWS acme-prod/ }));
    expect(commandMock).toHaveBeenCalledWith('target.refresh', { targetId: aws.id });
    expect(screen.getByRole('button', { name: /^Edit · AWS acme-prod/ })).toBeTruthy();
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

  it('Agents · picking another detected binary dispatches detect.setBinary', () => {
    const ext = '/ext/claude';
    const m = fixtures.demoReadModel();
    const clis = m.discovery.clis.map((c) =>
      c.agent === 'claude'
        ? {
            ...c,
            capabilities: {
              streamJson: true,
              source: 'path',
              alternatives: [
                { binary: c.binary ?? '', version: c.version, source: 'path' },
                { binary: ext, version: '2.1.261', source: 'vscode-extension' },
              ],
            },
          }
        : c,
    );
    seed({ ...m, discovery: { ...m.discovery, clis } });
    useUiStore.setState({ settingsSection: 'app:agents' });
    render(<Settings />);
    fireEvent.change(screen.getByLabelText('Claude Code binary'), { target: { value: ext } });
    expect(commandMock).toHaveBeenCalledWith('detect.setBinary', { agent: 'claude', path: ext });
  });

  it('Agents · the app-level connections table sits above the preference rows', () => {
    render(<Settings />);
    fireEvent.click(screen.getByRole('button', { name: 'Agents' }));
    expect(screen.getByRole('heading', { name: 'Agents' })).toBeTruthy();
    expect(screen.getByText(copy.agentsPage.lead)).toBeTruthy();
    const table = screen.getByRole('table', { name: copy.agentsPage.title });
    expect(table.querySelectorAll('[data-agent-row]')).toHaveLength(5);
    expect(screen.getByText(copy.agentsPage.preferences)).toBeTruthy();
    expect(screen.getByRole('combobox', { name: copy.settings.rows.defaultAgent })).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: copy.settings.rows.autoWorktree }), {
      target: { value: 'off' },
    });
    expect(commandMock).toHaveBeenCalledWith('settings.set', { patch: { autoWorktreePerAgent: false } });
    fireEvent.click(screen.getByRole('button', { name: /^Connect · Gemini CLI/ }));
    expect(useUiStore.getState().overlays).toMatchObject([
      { kind: 'modal', modal: 'connect-agent', agent: 'gemini' },
    ]);
  });

  it('Editor · Screen reader mode dispatches settings.set { screenReader } (spec §9)', () => {
    render(<Settings />);
    fireEvent.click(screen.getByRole('button', { name: 'Editor' }));
    const select = screen.getByRole('combobox', { name: copy.settings.rows.screenReader });
    expect((select as HTMLSelectElement).value).toBe('off');
    fireEvent.change(select, { target: { value: 'on' } });
    expect(commandMock).toHaveBeenCalledWith('settings.set', { patch: { screenReader: true } });
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
    fireEvent.change(screen.getByRole('combobox', { name: 'Permission mode' }), {
      target: { value: 'acceptEdits' },
    });
    expect(commandMock).toHaveBeenCalledWith('project.settings.set', {
      projectId: acme,
      patch: { permissionMode: 'acceptEdits' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Effort' }), { target: { value: 'high' } });
    expect(commandMock).toHaveBeenCalledWith('project.settings.set', {
      projectId: acme,
      patch: { effort: 'high' },
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

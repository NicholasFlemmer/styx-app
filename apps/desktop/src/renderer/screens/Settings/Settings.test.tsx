// @vitest-environment jsdom
import { copy, fixtures, type ModelInfo } from '@styx/core';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { CLI_BINARY_AUTO, sectionRows } from './rows';
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

  it('a located binary always gets the Select, with "Detected automatically" to undo the pick', () => {
    const picked = '/Users/nic/Downloads/claude';
    const m = fixtures.demoReadModel();
    const clis = m.discovery.clis.map((c) =>
      c.agent === 'claude'
        ? {
            ...c,
            binary: picked,
            version: '2.0.0',
            capabilities: {
              streamJson: true,
              source: 'manual',
              alternatives: [{ binary: picked, version: '2.0.0', source: 'manual' }],
            },
          }
        : c,
    );
    const rows = sectionRows({ ...m, discovery: { ...m.discovery, clis } }, 'app:agents', ctx);
    const pick = rows.find((r) => r.id === 'cliBinary:claude');
    expect(pick).toMatchObject({ value: picked, change: { kind: 'cli-binary', agent: 'claude' } });
    expect(pick?.options).toEqual([
      { value: picked, label: 'claude 2.0.0 · located manually' },
      { value: CLI_BINARY_AUTO, label: copy.settings.values.cliAutoDetect },
    ]);
  });

  it('project rows mark `source === "project"` keys as overridden', () => {
    const rows = sectionRows(model, 'project:agent-defaults', ctx);
    expect(rows.map((r) => [r.id, r.overridden])).toEqual([
      ['defaultAgent', true],
      ['model', false],
      ['autoApproveEdits', false],
      ['permissionMode', false],
      ['taskPermissionMode', false],
      ['effort', false],
      ['syncOnSpawn', false],
      ['syncBeforePublish', false],
      ['autoSync', false],
      ['integration', false],
      ['autoLand', false],
      ['checksCommand', false],
    ]);
  });

  it('Agent defaults: keep-lanes-current rows are on by default and patch the project settings (ADR-0023)', () => {
    const rows = sectionRows(model, 'project:agent-defaults', ctx);
    const spawn = rows.find((r) => r.id === 'syncOnSpawn');
    const publish = rows.find((r) => r.id === 'syncBeforePublish');
    expect(spawn).toMatchObject({ label: 'Fetch before cutting a lane', value: 'on' });
    expect(publish).toMatchObject({ label: 'Bring in the base branch before publishing', value: 'on' });
    expect(spawn?.options.map((o) => o.label)).toEqual(['On', 'Off']);
    expect(publish?.change.kind === 'project' && publish.change.patch('off')).toEqual({
      syncBeforePublish: false,
    });
    // ADR-0025: the base comes in after every turn unless told otherwise.
    const auto = rows.find((r) => r.id === 'autoSync');
    expect(auto).toMatchObject({ label: 'Bring in the base branch', value: 'turn' });
    expect(auto?.options.map((o) => o.label)).toEqual([
      'After every turn',
      'Before publishing',
      'Only when I ask',
    ]);
    expect(auto?.change.kind === 'project' && auto.change.patch('off')).toEqual({ autoSync: 'off' });
    expect(auto?.change.kind === 'project' && auto.change.patch('bogus')).toEqual({ autoSync: 'turn' });
    // Phase B/C: auto by default (owner decision); review is one switch away.
    const integration = rows.find((r) => r.id === 'integration');
    expect(integration).toMatchObject({ label: 'Merging', value: 'auto' });
    expect(integration?.options.map((o) => o.label)).toEqual([
      'Keep my project up to date for me',
      'I review and merge myself',
    ]);
    expect(integration?.change.kind === 'project' && integration.change.patch('review')).toEqual({
      integration: 'review',
    });
    // Phase C: landing by itself is opt-in.
    const autoLand = rows.find((r) => r.id === 'autoLand');
    expect(autoLand).toMatchObject({
      label: 'Land on its own when the agent goes quiet and the checks pass',
      value: 'off',
    });
    expect(autoLand?.change.kind === 'project' && autoLand.change.patch('on')).toEqual({ autoLand: true });
  });

  it('Agent defaults › Checks (issue #2): shows the command Land runs, typed rather than picked; blank clears it; a project-file value can be reset', () => {
    const none = sectionRows(model, 'project:agent-defaults', ctx).find((r) => r.id === 'checksCommand');
    expect(none).toMatchObject({
      label: copy.settings.rows.checksCommand,
      value: '',
      placeholder: copy.settings.values.checksNone,
      overridden: false,
      change: { kind: 'project-text', key: 'checksCommand' },
    });
    expect(none?.change.kind === 'project-text' && none.change.patch('  pnpm test ')).toEqual({
      checksCommand: 'pnpm test',
    });
    expect(none?.change.kind === 'project-text' && none.change.patch('   ')).toEqual({ checksCommand: null });
    const settings = model.settings.project[acme];
    if (settings === undefined) throw new Error('fixture settings');
    const filed = {
      ...model,
      settings: {
        ...model.settings,
        project: {
          ...model.settings.project,
          [acme]: { ...settings, checksCommand: { value: 'make check', source: 'project' as const } },
        },
      },
    };
    expect(
      sectionRows(filed, 'project:agent-defaults', ctx).find((r) => r.id === 'checksCommand'),
    ).toMatchObject({ value: 'make check', overridden: true });
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
    expect(mode?.value).toBe('auto');
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

  it('Agent defaults follow the default agent: Codex lists its catalogue and per-model efforts; Gemini has no effort row (discrepancy #83)', () => {
    const eff = model.settings.project[acme];
    if (eff === undefined) throw new Error('fixture');
    const codexModels: ModelInfo[] = [
      {
        id: 'gpt-6-astra',
        label: 'GPT-6 Astra',
        description: null,
        efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultEffort: 'low',
        isDefault: true,
        hidden: false,
      },
      {
        id: 'gpt-5.5',
        label: 'GPT-5.5',
        description: null,
        efforts: ['low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'xhigh',
        isDefault: false,
        hidden: false,
      },
    ];
    const withAgent = (agent: 'codex' | 'gemini', modelValue: string | null) => ({
      ...model,
      discovery: {
        ...model.discovery,
        clis: model.discovery.clis.map((c) =>
          c.agent === 'codex' ? { ...c, capabilities: { ...c.capabilities, models: codexModels } } : c,
        ),
      },
      settings: {
        ...model.settings,
        project: {
          ...model.settings.project,
          [acme]: {
            ...eff,
            defaultAgent: { value: agent, source: 'project' as const },
            model: { value: modelValue, source: 'project' as const },
            effort: { value: 'ultra' as const, source: 'project' as const },
          },
        },
      },
    });
    const codexRows = sectionRows(withAgent('codex', null), 'project:agent-defaults', ctx);
    expect(codexRows.find((r) => r.id === 'model')?.options.map((o) => [o.value, o.label])).toEqual([
      ['default', 'Default'],
      ['gpt-6-astra', 'GPT-6 Astra'],
      ['gpt-5.5', 'GPT-5.5'],
    ]);
    // Default model → the default row's efforts, ultra included.
    expect(codexRows.find((r) => r.id === 'effort')?.options.map((o) => o.value)).toEqual([
      'default',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    // gpt-5.5 has no ultra; the stored one stays selectable so the row shows what project.json says.
    const gpt55 = sectionRows(withAgent('codex', 'gpt-5.5'), 'project:agent-defaults', ctx).find(
      (r) => r.id === 'effort',
    );
    expect(gpt55?.value).toBe('ultra');
    expect(gpt55?.options.map((o) => o.value)).toEqual([
      'default',
      'low',
      'medium',
      'high',
      'xhigh',
      'ultra',
    ]);
    expect(gpt55?.change.kind === 'project' && gpt55.change.patch('bogus')).toEqual({ effort: null });
    const geminiRows = sectionRows(withAgent('gemini', null), 'project:agent-defaults', ctx);
    expect(geminiRows.map((r) => r.id)).toEqual([
      'defaultAgent',
      'model',
      'autoApproveEdits',
      'permissionMode',
      'taskPermissionMode',
      'syncOnSpawn',
      'syncBeforePublish',
      'autoSync',
      'integration',
      'autoLand',
      'checksCommand',
    ]);
    expect(geminiRows.find((r) => r.id === 'model')?.options.map((o) => o.value)).toEqual(['default']);
  });

  it('General › Updates (#119): the status line is the value; Check now / Restart to update are the actions', () => {
    const at = (update: Partial<typeof model.update>) =>
      sectionRows({ ...model, update: { ...model.update, current: '0.2.0', ...update } }, 'app:general', {
        ...ctx,
        now: fixtures.DEMO_NOW,
      }).find((r) => r.id === 'updates');
    expect(at({ status: 'off' })).toMatchObject({
      label: 'Updates',
      value: 'status',
      change: { kind: 'fixed' },
      options: [{ value: 'status', label: 'Updates are off in this build' }],
    });
    expect(at({ status: 'idle', checkedAt: fixtures.DEMO_NOW - 5 * 60_000 })?.options).toEqual([
      { value: 'status', label: '0.2.0 · up to date · checked 5m' },
      { value: 'check', label: 'Check now' },
    ]);
    expect(at({ status: 'downloading', next: '0.2.1', percent: 40 })?.options).toEqual([
      { value: 'status', label: 'Downloading 0.2.1 · 40%' },
    ]);
    expect(at({ status: 'ready', next: '0.2.1' })).toMatchObject({
      change: { kind: 'update' },
      options: [
        { value: 'status', label: '0.2.1 is ready — restart to install' },
        { value: 'install', label: 'Restart to update' },
      ],
    });
    expect(at({ status: 'error', error: 'no connection' })?.options.map((o) => o.label)).toEqual([
      '0.2.0 · could not check: no connection',
      'Check now',
    ]);
  });

  it('Settings › General has a Walkthrough row whose Show plays it (#124)', () => {
    const row = sectionRows(model, 'app:general', ctx).find((r) => r.id === 'tour');
    expect(row?.label).toBe('Walkthrough');
    expect(row?.change).toEqual({ kind: 'tour' });
    expect(row?.options.map((o) => o.label)).toEqual(['Seen', 'Show the walkthrough']);
  });

  it('prototype values match settingsRowsMap', () => {
    const values = (section: Parameters<typeof sectionRows>[1]) =>
      sectionRows(model, section, ctx).map((r) => r.options.find((o) => o.value === r.value)?.label);
    expect(values('app:general')).toEqual([
      'System',
      'Badge + sound',
      'On',
      'Updates are off in this build',
      // The walkthrough row (#124): the demo machine has seen it.
      'Seen',
    ]);
    // Line endings, Auto-create worktree, Inject as and Share with agents were stored but never applied (issue #4).
    expect(values('app:editor')).toEqual(['Monaco (embedded)', 'Styx', 'VS Code', 'Off', 'On']);
    expect(values('app:agents')).toEqual(['Claude Code', 'PowerShell', 'claude, codex, gemini, cursor']);
    expect(values('app:keychain')).toEqual(['macOS Keychain', 'Touch ID']);
    // Demo fixture mirrors the prototype policies strip (`[false, true, true]`): staging reads are off.
    expect(values('app:policies')).toEqual(['Off', '1 hour', 'JSON']);
    expect(values('project:agent-defaults')).toEqual([
      'Claude Code',
      'Default',
      'Off',
      'Auto',
      'Bypass permissions',
      'Default effort',
      'On',
      'On',
      'After every turn',
      'Keep my project up to date for me',
      'Off',
      // The checks command is typed, not picked (issue #2): no option label.
      undefined,
    ]);
    expect(values('project:env')).toEqual(['Keychain', '.styx/project.json']);
  });

  it('issue #4: rows that were stored but changed nothing are gone; every row left is one main reads', () => {
    const ids = (['app:editor', 'app:agents', 'app:keychain', 'project:env'] as const).flatMap((section) =>
      sectionRows(model, section, ctx).map((r) => r.id),
    );
    for (const gone of ['lineEndings', 'autoWorktree', 'injectAs', 'shareWithAgents'])
      expect(ids).not.toContain(gone);
    // Wired instead: Notify (badge, tray, OS and in-app toasts), Open files in, Shell (Windows).
    expect(ids).toEqual(expect.arrayContaining(['openFilesIn', 'shellWindows']));
    const notify = sectionRows(model, 'app:general', ctx).find((r) => r.id === 'notify');
    expect(notify?.options.map((o) => o.value)).toEqual(['badge-sound', 'badge', 'off']);
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

  it('Remove arms on the first press (accent, "Remove?") and removes on the second; a press elsewhere disarms', () => {
    render(<Settings />);
    const remove = screen.getByRole('button', { name: /^Remove · Supabase prod/ });
    expect(remove.textContent).toBe(copy.targets.actions.remove);
    fireEvent.click(remove);
    expect(remove.textContent).toBe(copy.targets.actions.removeConfirm);
    expect(remove.getAttribute('data-on')).toBe('true');
    expect(commandMock).not.toHaveBeenCalledWith('target.remove', expect.anything());
    // Arming another row disarms this one.
    fireEvent.click(screen.getByRole('button', { name: /^Remove · Vercel prod/ }));
    expect(remove.textContent).toBe(copy.targets.actions.remove);
    fireEvent.click(remove);
    fireEvent.click(remove);
    expect(commandMock).toHaveBeenCalledWith('target.remove', { targetId: fixtures.ids.target.supabaseProd });
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

  it('supabase targets show their project (or that none is chosen) and Choose project opens the picker', () => {
    const m = fixtures.demoReadModel();
    const sb = m.targets.byId[fixtures.ids.target.supabaseProd];
    if (sb === undefined) throw new Error('no supabase target');
    render(<Settings />);
    const table = screen.getByRole('table', { name: 'Targets' });
    const meta = () => table.querySelector(`[data-target-id="${sb.id}"] [data-target-meta="project"]`);
    expect(meta()?.textContent).toBe('project acme-shop-prod');
    // Only project providers get it.
    expect(screen.getAllByRole('button', { name: /^Choose project · / })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /^Choose project · Supabase prod/ }));
    expect(useUiStore.getState().overlays).toMatchObject([
      {
        kind: 'modal',
        modal: 'connect',
        projectId: acme,
        provider: 'supabase',
        targetId: sb.id,
        chooseProject: true,
      },
    ]);
    cleanup();
    seed({
      ...m,
      targets: { ...m.targets, byId: { ...m.targets.byId, [sb.id]: { ...sb, config: {} } } },
    });
    render(<Settings />);
    expect(
      screen
        .getByRole('table', { name: 'Targets' })
        .querySelector(`[data-target-id="${sb.id}"] [data-target-meta="project"]`)?.textContent,
    ).toBe(copy.connect.project.notChosen);
  });

  it('Deploy commands… opens the per-target deploy setup modal for the project', () => {
    render(<Settings />);
    fireEvent.click(screen.getByRole('button', { name: copy.deploy.commands }));
    expect(useUiStore.getState().overlays).toMatchObject([
      { kind: 'modal', modal: 'deploy-setup', projectId: acme },
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
  });

  it('app settings have their own nav; a project option shows without it (ADR-0027 §5)', () => {
    const { unmount } = render(<Settings />);
    // A project's option (opened from the project nav, which stays beside it): no settings nav of its own.
    expect(screen.queryByRole('navigation', { name: copy.settings.groups.label })).toBeNull();
    expect(screen.getByRole('heading', { name: copy.settings.project.targets })).toBeTruthy();
    unmount();
    act(() => useUiStore.getState().setSettingsSection('app:account'));
    render(<Settings />);
    const nav = screen.getByRole('navigation', { name: copy.settings.groups.label });
    const items = Array.from(nav.querySelectorAll('[data-settings-nav-item]')).map((b) =>
      b.getAttribute('data-settings-nav-item'),
    );
    expect(items).toEqual([
      'app:general',
      'app:account',
      'app:editor',
      'app:agents',
      'app:skills',
      'app:keychain',
      'app:policies',
      'app:shortcuts',
    ]);
    expect(nav.textContent).not.toContain('This project');
    fireEvent.click(nav.querySelector('[data-settings-nav-item="app:general"]') as HTMLElement);
    expect(useUiStore.getState().settingsSection).toBe('app:general');
    expect(screen.getByRole('heading', { name: 'General' })).toBeTruthy();
    expect(screen.getByText('app')).toBeTruthy();

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
    // The Codex verifier reports "email · plan" through `account/read` (docs/research/agent-parity.md §2.4).
    const model = fixtures.demoReadModel();
    seed({
      ...model,
      discovery: {
        ...model.discovery,
        clis: model.discovery.clis.map((c) =>
          c.agent === 'codex' ? { ...c, account: 'nic@acme.dev · team' } : c,
        ),
      },
    });
    render(<Settings />);
    act(() => useUiStore.getState().setSettingsSection('app:agents'));
    expect(screen.getByRole('heading', { name: 'Agents' })).toBeTruthy();
    expect(screen.getByText(copy.agentsPage.lead)).toBeTruthy();
    const table = screen.getByRole('table', { name: copy.agentsPage.title });
    expect(table.querySelectorAll('[data-agent-row]')).toHaveLength(6);
    // The account cell carries the full string as its title: "email · plan" (the Codex verifier) is wider than the column.
    const codexAccount = table.querySelector('[data-agent-row="codex"] [data-agent-account]');
    expect(codexAccount?.textContent).toBe('nic@acme.dev · team');
    expect(codexAccount?.getAttribute('title')).toBe('nic@acme.dev · team');
    expect(screen.getByText(copy.agentsPage.preferences)).toBeTruthy();
    expect(screen.getByRole('combobox', { name: copy.settings.rows.defaultAgent })).toBeTruthy();
    // Shell (Windows) is the current project's (issue #4): it patches the project settings.
    fireEvent.change(screen.getByRole('combobox', { name: copy.settings.rows.shellWindows }), {
      target: { value: 'wsl' },
    });
    expect(commandMock).toHaveBeenCalledWith('project.settings.set', {
      projectId: acme,
      patch: { shellWindows: 'wsl' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Connect · Gemini CLI/ }));
    expect(useUiStore.getState().overlays).toMatchObject([
      { kind: 'modal', modal: 'connect-agent', agent: 'gemini' },
    ]);
  });

  it('Editor · Screen reader mode dispatches settings.set { screenReader } (spec §9)', () => {
    render(<Settings />);
    act(() => useUiStore.getState().setSettingsSection('app:editor'));
    const select = screen.getByRole('combobox', { name: copy.settings.rows.screenReader });
    expect((select as HTMLSelectElement).value).toBe('off');
    fireEvent.change(select, { target: { value: 'on' } });
    expect(commandMock).toHaveBeenCalledWith('settings.set', { patch: { screenReader: true } });
  });

  it('project rows: change → project.settings.set, Reset → project.settings.reset', () => {
    render(<Settings />);
    act(() => useUiStore.getState().setSettingsSection('project:agent-defaults'));
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

  it('Checks (issue #2): a text field — Enter or leaving it saves, Escape puts the saved value back, an unchanged one sends nothing', () => {
    render(<Settings />);
    act(() => useUiStore.getState().setSettingsSection('project:agent-defaults'));
    const field = screen.getByRole('textbox', { name: copy.settings.rows.checksCommand });
    expect(field).toHaveProperty('value', '');
    expect(field.getAttribute('placeholder')).toBe(copy.settings.values.checksNone);
    fireEvent.blur(field);
    expect(commandMock).not.toHaveBeenCalledWith('project.settings.set', expect.anything());
    fireEvent.change(field, { target: { value: 'pnpm typecheck && pnpm test' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(commandMock).toHaveBeenCalledWith('project.settings.set', {
      projectId: acme,
      patch: { checksCommand: 'pnpm typecheck && pnpm test' },
    });
    commandMock.mockClear();
    fireEvent.change(field, { target: { value: 'oops' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(field).toHaveProperty('value', '');
    fireEvent.blur(field);
    expect(commandMock).not.toHaveBeenCalled();
  });

  it('a project section names the committed file in its header; an app section does not', () => {
    render(<Settings />);
    const file = () => document.querySelector('[data-settings-file]');
    expect(file()?.textContent).toContain(copy.settings.footer.file);
    expect(file()?.textContent).toContain(copy.settings.footer.note);
    act(() => useUiStore.getState().setSettingsSection('app:general'));
    expect(file()).toBeNull();
  });
});

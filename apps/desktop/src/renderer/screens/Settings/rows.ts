import {
  BUILTIN_POLICY_IDS,
  copy,
  DEFAULT_PROJECT_SETTINGS,
  formatChord,
  platformCopy,
  projectSettingsOf,
  type AppSettings,
  type Platform,
  type PolicyId,
  type ProjectId,
  type ProjectSettings,
  type ReadModel,
} from '@styx/core';
import { shortcuts } from '@styx/tokens';
import type { SettingsSection } from './sections';

/** What a row's Select dispatches. `fixed` rows are informational (engine, store, shortcuts …). */
export type RowChange =
  | { kind: 'fixed' }
  | { kind: 'app'; patch: (value: string) => Partial<AppSettings> }
  | { kind: 'project'; key: keyof ProjectSettings; patch: (value: string) => Partial<ProjectSettings> }
  | { kind: 'policy'; policyId: PolicyId };

export interface RowOption {
  value: string;
  label: string;
}

/** One label/value row of a non-Targets section (prototype `settingsRowsMap`). */
export interface SettingsRow {
  id: string;
  label: string;
  /** Current option value. */
  value: string;
  options: readonly RowOption[];
  change: RowChange;
  /** Project value from `.styx/project.json` → reset affordance (plan §5, spec §4.6). */
  overridden: boolean;
}

export interface RowContext {
  projectId: ProjectId | null;
  platform: Platform;
}

const ON = 'on';
const OFF = 'off';
const onOff = (b: boolean): string => (b ? ON : OFF);
const isOn = (v: string): boolean => v === ON;
const ON_OFF: readonly RowOption[] = [
  { value: ON, label: copy.settings.values.on },
  { value: OFF, label: copy.settings.values.off },
];

const MODEL_DEFAULT = 'default';
const NO_IDE = 'none';

const fixed = (id: string, label: string, value: string): SettingsRow => ({
  id,
  label,
  value,
  options: [{ value, label: value }],
  change: { kind: 'fixed' },
  overridden: false,
});

const optionsOf = <T extends string>(labels: Readonly<Record<T, string>>, keys: readonly T[]): RowOption[] =>
  keys.map((value) => ({ value, label: labels[value] }));

const projectRow = <K extends keyof ProjectSettings>(
  model: ReadModel,
  ctx: RowContext,
  id: string,
  label: string,
  key: K,
  encode: (v: ProjectSettings[K]) => string,
  decode: (v: string) => ProjectSettings[K],
  options: readonly RowOption[],
  showOverride: boolean,
): SettingsRow => {
  const eff = ctx.projectId === null ? null : projectSettingsOf(model, ctx.projectId);
  const entry = eff?.[key];
  const value = entry === undefined ? DEFAULT_PROJECT_SETTINGS[key] : entry.value;
  return {
    id,
    label,
    value: encode(value),
    options,
    change: { kind: 'project', key, patch: (v) => ({ [key]: decode(v) }) as Partial<ProjectSettings> },
    overridden: showOverride && entry?.source === 'project',
  };
};

const AGENT_OPTIONS: readonly RowOption[] = optionsOf(copy.agentProducts, [
  'claude',
  'codex',
  'gemini',
  'cursor',
  'shell',
]);

const generalRows = (model: ReadModel): SettingsRow[] => {
  const app = model.settings.app;
  const r = copy.settings.rows;
  const v = copy.settings.values;
  return [
    {
      id: 'theme',
      label: r.theme,
      value: app.theme,
      options: optionsOf(v.theme, ['system', 'dark', 'light']),
      change: { kind: 'app', patch: (t) => ({ theme: t as AppSettings['theme'] }) },
      overridden: false,
    },
    {
      id: 'notify',
      label: r.notify,
      value: app.notify,
      options: optionsOf(v.notify, ['badge-sound', 'badge', 'off']),
      change: { kind: 'app', patch: (n) => ({ notify: n as AppSettings['notify'] }) },
      overridden: false,
    },
    {
      id: 'launchAtLogin',
      label: r.launchAtLogin,
      value: onOff(app.launchAtLogin),
      options: ON_OFF,
      change: { kind: 'app', patch: (b) => ({ launchAtLogin: isOn(b) }) },
      overridden: false,
    },
  ];
};

const editorRows = (model: ReadModel, ctx: RowContext): SettingsRow[] => {
  const app = model.settings.app;
  const r = copy.settings.rows;
  const v = copy.settings.values;
  const seen = new Set<string>();
  const ides = model.discovery.ides.filter((ide) => {
    if (seen.has(ide.kind)) return false;
    seen.add(ide.kind);
    return true;
  });
  const fallbackKind = app.fallbackIde ?? ides.find((i) => i.isFallback)?.kind ?? null;
  const ideOptions: RowOption[] = ides.map((i) => ({ value: i.kind, label: i.product }));
  if (fallbackKind === null || !ides.some((i) => i.kind === fallbackKind)) {
    ideOptions.unshift({ value: NO_IDE, label: copy.general.none });
  }
  return [
    fixed('engine', r.engine, v.engine),
    {
      id: 'openFilesIn',
      label: r.openFilesIn,
      value: app.openFilesIn,
      options: optionsOf(v.openFilesIn, ['styx', 'fallback']),
      change: { kind: 'app', patch: (o) => ({ openFilesIn: o as AppSettings['openFilesIn'] }) },
      overridden: false,
    },
    {
      id: 'fallbackEditor',
      label: r.fallbackEditor,
      value: fallbackKind ?? NO_IDE,
      options: ideOptions,
      change: {
        kind: 'app',
        patch: (k) => ({ fallbackIde: k === NO_IDE ? null : (k as AppSettings['fallbackIde']) }),
      },
      overridden: false,
    },
    projectRow(
      model,
      ctx,
      'lineEndings',
      r.lineEndings,
      'lineEndings',
      (x) => x,
      (x) => x as ProjectSettings['lineEndings'],
      optionsOf(v.lineEndings, ['auto', 'lf', 'crlf']),
      false,
    ),
    // Spec §9: Monaco screen-reader mode + xterm accessibility tree (settings.app.screenReader).
    {
      id: 'screenReader',
      label: r.screenReader,
      value: onOff(app.screenReader),
      options: ON_OFF,
      change: { kind: 'app', patch: (b) => ({ screenReader: isOn(b) }) },
      overridden: false,
    },
  ];
};

const agentsRows = (model: ReadModel, ctx: RowContext): SettingsRow[] => {
  const app = model.settings.app;
  const r = copy.settings.rows;
  const v = copy.settings.values;
  const clis = model.discovery.clis.filter((c) => c.found && c.agent !== 'shell').map((c) => c.agent);
  return [
    projectRow(
      model,
      ctx,
      'defaultAgent',
      r.defaultAgent,
      'defaultAgent',
      (a) => a,
      (a) => a as ProjectSettings['defaultAgent'],
      AGENT_OPTIONS,
      false,
    ),
    {
      id: 'autoWorktree',
      label: r.autoWorktree,
      value: onOff(app.autoWorktreePerAgent),
      options: ON_OFF,
      change: { kind: 'app', patch: (b) => ({ autoWorktreePerAgent: isOn(b) }) },
      overridden: false,
    },
    projectRow(
      model,
      ctx,
      'shellWindows',
      r.shellWindows,
      'shellWindows',
      (s) => s,
      (s) => s as ProjectSettings['shellWindows'],
      optionsOf(v.shellWindows, ['powershell', 'wsl']),
      false,
    ),
    fixed('detectedClis', r.detectedClis, clis.length === 0 ? copy.general.none : clis.join(', ')),
  ];
};

const keychainRows = (model: ReadModel, ctx: RowContext): SettingsRow[] => {
  const app = model.settings.app;
  const r = copy.settings.rows;
  const v = copy.settings.values;
  const pc = platformCopy(ctx.platform);
  return [
    fixed('store', r.store, pc.keychainName),
    fixed('mfaProdWrite', r.mfaProdWrite, pc.mfa),
    {
      id: 'injectAs',
      label: r.injectAs,
      value: app.injectAs,
      options: optionsOf(v.injectAs, ['scoped-else-env', 'env']),
      change: { kind: 'app', patch: (i) => ({ injectAs: i as AppSettings['injectAs'] }) },
      overridden: false,
    },
  ];
};

const policiesRows = (model: ReadModel): SettingsRow[] => {
  const r = copy.settings.rows;
  const v = copy.settings.values;
  const stagingId = BUILTIN_POLICY_IDS['auto-read-staging-preview'];
  const staging = model.policies.byId[stagingId];
  const stagingRow: SettingsRow =
    staging === undefined
      ? fixed('autoApproveStagingReads', r.autoApproveStagingReads, v.on)
      : {
          id: 'autoApproveStagingReads',
          label: r.autoApproveStagingReads,
          value: onOff(staging.enabled),
          options: ON_OFF,
          change: { kind: 'policy', policyId: stagingId },
          overridden: false,
        };
  return [
    stagingRow,
    fixed('grantIdleExpiry', r.grantIdleExpiry, v.idleExpiry),
    fixed('export', r.export, v.exportJson),
  ];
};

const shortcutsRows = (ctx: RowContext): SettingsRow[] => {
  const r = copy.settings.rows;
  const p = ctx.platform;
  const first = shortcuts.focusAgent[0];
  const last = shortcuts.focusAgent[shortcuts.focusAgent.length - 1] ?? first;
  const lastKey = last.split('+').at(-1) ?? '';
  return [
    fixed('palette', r.palette, formatChord(shortcuts.palette, p)),
    fixed('switchProject', r.switchProject, formatChord(shortcuts.switchProject, p)),
    fixed('focusAgent', r.focusAgent, `${formatChord(first, p)}–${lastKey}`),
    fixed(
      'approveDeny',
      r.approveDeny,
      `${formatChord(shortcuts.approve, p)} / ${formatChord(shortcuts.deny, p)}`,
    ),
  ];
};

const agentDefaultsRows = (model: ReadModel, ctx: RowContext): SettingsRow[] => {
  const r = copy.settings.rows;
  const v = copy.settings.values;
  const eff = ctx.projectId === null ? null : projectSettingsOf(model, ctx.projectId);
  const currentModel = eff?.model.value ?? DEFAULT_PROJECT_SETTINGS.model;
  const modelOptions: RowOption[] = [{ value: MODEL_DEFAULT, label: v.modelDefault }];
  if (currentModel !== null) modelOptions.push({ value: currentModel, label: currentModel });
  return [
    projectRow(
      model,
      ctx,
      'defaultAgent',
      r.defaultAgent,
      'defaultAgent',
      (a) => a,
      (a) => a as ProjectSettings['defaultAgent'],
      AGENT_OPTIONS,
      true,
    ),
    projectRow(
      model,
      ctx,
      'model',
      r.model,
      'model',
      (m) => m ?? MODEL_DEFAULT,
      (m) => (m === MODEL_DEFAULT ? null : m),
      modelOptions,
      true,
    ),
    projectRow(
      model,
      ctx,
      'autoApproveEdits',
      r.autoApproveEdits,
      'autoApproveEdits',
      onOff,
      isOn,
      ON_OFF,
      true,
    ),
  ];
};

const envRows = (model: ReadModel, ctx: RowContext): SettingsRow[] => {
  const r = copy.settings.rows;
  const v = copy.settings.values;
  return [
    fixed('envSource', r.envSource, v.envSource),
    projectRow(
      model,
      ctx,
      'shareWithAgents',
      r.shareWithAgents,
      'envShareWithAgents',
      (s) => s,
      (s) => s as ProjectSettings['envShareWithAgents'],
      optionsOf(v.shareWithAgents, ['per-grant', 'always', 'never']),
      true,
    ),
    fixed('committedFile', r.committedFile, v.committedFile),
  ];
};

/** Rows for every section except Targets (which is a table, see `targetRows` in core). */
export const sectionRows = (model: ReadModel, section: SettingsSection, ctx: RowContext): SettingsRow[] => {
  switch (section) {
    case 'app:general':
      return generalRows(model);
    case 'app:editor':
      return editorRows(model, ctx);
    case 'app:agents':
      return agentsRows(model, ctx);
    case 'app:keychain':
      return keychainRows(model, ctx);
    case 'app:policies':
      return policiesRows(model);
    case 'app:shortcuts':
      return shortcutsRows(ctx);
    case 'project:agent-defaults':
      return agentDefaultsRows(model, ctx);
    case 'project:env':
      return envRows(model, ctx);
    case 'project:targets':
      return [];
  }
};

import {
  BUILTIN_POLICY_IDS,
  PERMISSION_MODES,
  cliAlternatives,
  cliCandidateLabel,
  cliIsManual,
  cliLocationLabel,
  cliSourceOf,
  copy,
  DEFAULT_PROJECT_SETTINGS,
  fill,
  formatAge,
  formatChord,
  modelCatalogueFor,
  platformCopy,
  projectSettingsOf,
  type Agent,
  type AppSettings,
  type CopyPlatform,
  type Platform,
  type PolicyId,
  type ProjectId,
  type ProjectSettings,
  type ReadModel,
  tourSeen,
} from '@styx/core';
import { shortcuts } from '@styx/tokens';
import {
  decodeEffort,
  effortOptionsFor,
  modelOptionsFor,
  takesEffort,
} from '../../features/chat/session-controls';
import type { SettingsSection } from './sections';

/** What a row's Select dispatches. `fixed` rows are informational (engine, store, shortcuts …). */
export type RowChange =
  | { kind: 'fixed' }
  | { kind: 'app'; patch: (value: string) => Partial<AppSettings> }
  | { kind: 'project'; key: keyof ProjectSettings; patch: (value: string) => Partial<ProjectSettings> }
  | { kind: 'policy'; policyId: PolicyId }
  /** Pick among the binaries detected for one agent (`detect.setBinary`, value = binary path). */
  | { kind: 'cli-binary'; agent: Agent }
  /** Updates in place (#119): the row's value is the status line; `check` asks the feed, `install` restarts. */
  | { kind: 'update' }
  /** The walkthrough (#124): the value says whether it was seen; `show` plays it. */
  | { kind: 'tour' };

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
  /** Keyboard platform: shortcut chords (discrepancy #21). */
  platform: Platform;
  /** Rendered-chrome platform: keychain / MFA words (spec §7); Linux has its own. */
  copyPlatform: CopyPlatform;
  /** The clock for relative times ("checked 5m ago"); the injected app clock in the screen, `Date.now()` otherwise. */
  now?: number;
}

const ON = 'on';
const OFF = 'off';
const onOff = (b: boolean): string => (b ? ON : OFF);
const isOn = (v: string): boolean => v === ON;
const ON_OFF: readonly RowOption[] = [
  { value: ON, label: copy.settings.values.on },
  { value: OFF, label: copy.settings.values.off },
];
/** ADR-0025: when the base branch comes into a lane by itself. */
const AUTO_SYNC_VALUES = ['turn', 'publish', 'off'] as const;
const AUTO_SYNC_OPTIONS: readonly RowOption[] = AUTO_SYNC_VALUES.map((v) => ({
  value: v,
  label: copy.settings.values.autoSync[v],
}));
const isAutoSync = (v: string): v is (typeof AUTO_SYNC_VALUES)[number] =>
  (AUTO_SYNC_VALUES as readonly string[]).includes(v);
/** ADR-0025 phase B/C: who waits — Styx keeps the project current, or the human reviews and merges. */
const INTEGRATION_VALUES = ['auto', 'review'] as const;
const INTEGRATION_OPTIONS: readonly RowOption[] = INTEGRATION_VALUES.map((v) => ({
  value: v,
  label: copy.settings.values.integration[v],
}));
const isIntegration = (v: string): v is (typeof INTEGRATION_VALUES)[number] =>
  (INTEGRATION_VALUES as readonly string[]).includes(v);

const MODEL_DEFAULT = 'default';
const NO_IDE = 'none';
/** `{cli} binary` option that forgets a "Locate binary" pick (`detect.clearBinary`); binaries are absolute paths, so no clash. */
export const CLI_BINARY_AUTO = 'auto';

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

const generalRows = (model: ReadModel, now: number): SettingsRow[] => {
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
    updatesRow(model, now),
    {
      id: 'tour',
      label: copy.tour.row,
      value: TOUR_STATUS,
      options: [
        { value: TOUR_STATUS, label: tourSeen(app) ? copy.tour.seen : copy.tour.notSeen },
        { value: TOUR_SHOW, label: copy.tour.show },
      ],
      change: { kind: 'tour' },
      overridden: false,
    },
  ];
};

/** The walkthrough row's two values: its own status line, and the action that plays it. */
export const TOUR_STATUS = 'status';
export const TOUR_SHOW = 'show';

/** `STATUS` is the row's own value (the status line); the other options are what can be done from here. */
export const UPDATE_STATUS = 'status';
export const UPDATE_CHECK = 'check';
export const UPDATE_INSTALL = 'install';

/** The running version and what the updater is doing, in one line (#119). */
export const updateStatusLine = (u: ReadModel['update'], now: number): string => {
  const c = copy.update.status;
  switch (u.status) {
    case 'off':
      return c.off;
    case 'idle':
      return u.checkedAt === null
        ? fill(c.idle, { current: u.current })
        : fill(c.idleChecked, { current: u.current, when: formatAge(u.checkedAt, now) });
    case 'checking':
      return fill(c.checking, { current: u.current });
    case 'downloading':
      return fill(c.downloading, { next: u.next ?? '', percent: u.percent ?? 0 });
    case 'ready':
      return fill(c.ready, { next: u.next ?? '' });
    case 'error':
      return fill(c.error, { current: u.current, error: u.error ?? '' });
  }
};

const updatesRow = (model: ReadModel, now: number): SettingsRow => {
  const u = model.update;
  const options: RowOption[] = [{ value: UPDATE_STATUS, label: updateStatusLine(u, now) }];
  if (u.status === 'idle' || u.status === 'error')
    options.push({ value: UPDATE_CHECK, label: copy.update.check });
  if (u.status === 'ready') options.push({ value: UPDATE_INSTALL, label: copy.update.restart });
  return {
    id: 'updates',
    label: copy.update.row,
    value: UPDATE_STATUS,
    options,
    change: u.status === 'off' ? { kind: 'fixed' } : { kind: 'update' },
    overridden: false,
  };
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
    // Owner decision: the hunk watcher is opt-in (it slowed the app at ~100 hunks).
    {
      id: 'trackAgentEdits',
      label: r.trackAgentEdits,
      value: onOff(app.trackAgentEdits),
      options: ON_OFF,
      change: { kind: 'app', patch: (b) => ({ trackAgentEdits: isOn(b) }) },
      overridden: false,
    },
  ];
};

const agentsRows = (model: ReadModel, ctx: RowContext): SettingsRow[] => {
  const app = model.settings.app;
  const r = copy.settings.rows;
  const v = copy.settings.values;
  const clis = model.discovery.clis.filter((c) => c.found && c.agent !== 'shell');
  // One Select per CLI with more than one runnable binary (PATH vs an IDE extension bundle …); value = binary path.
  // A located binary always gets the Select, with "Detected automatically" to undo the pick.
  const binaryRows: SettingsRow[] = clis.flatMap((c) => {
    const alternatives = cliAlternatives(c);
    const manual = cliIsManual(c);
    if ((alternatives.length < 2 && !manual) || c.binary === null) return [];
    const options: RowOption[] = alternatives.map((a) => ({
      value: a.binary,
      label: cliCandidateLabel(c.agent, a),
    }));
    if (manual) options.push({ value: CLI_BINARY_AUTO, label: v.cliAutoDetect });
    return [
      {
        id: `cliBinary:${c.agent}`,
        label: fill(r.cliBinary, { cli: copy.agentProducts[c.agent] }),
        value: c.binary,
        options,
        change: { kind: 'cli-binary', agent: c.agent },
        overridden: false,
      },
    ];
  });
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
    // "claude 2.1.261 · VS Code extension, codex" — detected rows carry version · source; rows without a recorded
    // source (fixtures, rows written before sources existed) keep the prototype's bare agent name.
    fixed(
      'detectedClis',
      r.detectedClis,
      clis.length === 0
        ? copy.general.none
        : clis.map((c) => (cliSourceOf(c) === null ? c.agent : cliLocationLabel(c))).join(', '),
    ),
    ...binaryRows,
  ];
};

const keychainRows = (model: ReadModel, ctx: RowContext): SettingsRow[] => {
  const app = model.settings.app;
  const r = copy.settings.rows;
  const v = copy.settings.values;
  const pc = platformCopy(ctx.copyPlatform);
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

/** Permission mode option list (Claude Code parity, discrepancy #54); main maps a mode onto each CLI (#83). */
const PERMISSION_MODE_OPTIONS: readonly RowOption[] = optionsOf(
  copy.session.permissionModes,
  PERMISSION_MODES,
);

const agentDefaultsRows = (model: ReadModel, ctx: RowContext): SettingsRow[] => {
  const r = copy.settings.rows;
  const v = copy.settings.values;
  const eff = ctx.projectId === null ? null : projectSettingsOf(model, ctx.projectId);
  const agent = eff?.defaultAgent.value ?? DEFAULT_PROJECT_SETTINGS.defaultAgent;
  const currentModel = eff?.model.value ?? DEFAULT_PROJECT_SETTINGS.model;
  const currentEffort = eff?.effort.value ?? DEFAULT_PROJECT_SETTINGS.effort;
  // The default agent's own lists (discrepancy #83): `Default` (prototype) then Claude's aliases or the
  // catalogue its CLI published; a model already in project.json that neither lists stays selectable.
  const catalogue = modelCatalogueFor(model, agent);
  const modelOptions: RowOption[] = modelOptionsFor(agent, currentModel, catalogue).map((o) =>
    o.value === MODEL_DEFAULT
      ? { value: o.value, label: v.modelDefault }
      : { value: o.value, label: o.label },
  );
  const effortOptions: RowOption[] = effortOptionsFor(agent, currentModel, catalogue, currentEffort).map(
    ({ value, label }) => ({ value, label }),
  );
  const effortRow: SettingsRow[] = takesEffort(agent)
    ? [
        projectRow(
          model,
          ctx,
          'effort',
          r.effort,
          'effort',
          (e) => e ?? MODEL_DEFAULT,
          decodeEffort,
          effortOptions,
          true,
        ),
      ]
    : [];
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
    projectRow(
      model,
      ctx,
      'permissionMode',
      r.permissionMode,
      'permissionMode',
      (m) => m,
      (m) =>
        (PERMISSION_MODES.includes(m as ProjectSettings['permissionMode'])
          ? m
          : 'default') as ProjectSettings['permissionMode'],
      PERMISSION_MODE_OPTIONS,
      true,
    ),
    // Styx's own tasks (owner decision): bypass by default; the same six modes, switchable here and in the task dialog.
    projectRow(
      model,
      ctx,
      'taskPermissionMode',
      r.taskPermissionMode,
      'taskPermissionMode',
      (m) => m,
      (m) =>
        (PERMISSION_MODES.includes(m as ProjectSettings['taskPermissionMode'])
          ? m
          : 'bypassPermissions') as ProjectSettings['taskPermissionMode'],
      PERMISSION_MODE_OPTIONS,
      true,
    ),
    ...effortRow,
    // Keep lanes current (ADR-0023): fetch before cutting a lane; merge the base in before push / PR.
    projectRow(model, ctx, 'syncOnSpawn', r.syncOnSpawn, 'syncOnSpawn', onOff, isOn, ON_OFF, true),
    projectRow(
      model,
      ctx,
      'syncBeforePublish',
      r.syncBeforePublish,
      'syncBeforePublish',
      onOff,
      isOn,
      ON_OFF,
      true,
    ),
    projectRow(
      model,
      ctx,
      'autoSync',
      r.autoSync,
      'autoSync',
      (v) => v,
      (v) => (isAutoSync(v) ? v : 'turn'),
      AUTO_SYNC_OPTIONS,
      true,
    ),
    projectRow(
      model,
      ctx,
      'integration',
      r.integration,
      'integration',
      (v) => v,
      (v) => (isIntegration(v) ? v : 'auto'),
      INTEGRATION_OPTIONS,
      true,
    ),
    // ADR-0025 phase C: off until trusted; a finished lane then lands on its own when the checks pass.
    projectRow(model, ctx, 'autoLand', r.autoLand, 'autoLand', onOff, isOn, ON_OFF, true),
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
      return generalRows(model, ctx.now ?? Date.now());
    case 'app:editor':
      return editorRows(model, ctx);
    case 'app:agents':
      return agentsRows(model, ctx);
    // Skills render their own pane, not label/value rows.
    case 'app:skills':
      return [];
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
    // Both are panes of their own, not label/value rows.
    case 'app:account':
      return [];
  }
};

import { z } from 'zod';
import { devPlatformSchema } from './run';
import { effortSchema, permissionModeSchema } from './session';
import { agentSchema } from './common';
import { ideKindSchema } from './discovery';
import { lineEndingsSchema } from './project';

export const themePreferenceSchema = z.enum(['dark', 'light', 'system']);
export type ThemePreference = z.infer<typeof themePreferenceSchema>;

export const notifyModeSchema = z.enum(['badge', 'badge-sound', 'off']);
export type NotifyMode = z.infer<typeof notifyModeSchema>;

export const windowsShellSchema = z.enum(['powershell', 'wsl']);
export type WindowsShell = z.infer<typeof windowsShellSchema>;

export const worktreeLocationSchema = z.enum(['sibling', 'inside']);
export type WorktreeLocation = z.infer<typeof worktreeLocationSchema>;

/** When Styx brings the base branch into a lane by itself (ADR-0025): after every turn, only before publishing, or never. */
export const autoSyncSchema = z.enum(['turn', 'publish', 'off']);
export type AutoSync = z.infer<typeof autoSyncSchema>;

/**
 * Who waits (ADR-0025 phase B/C): `auto` = Styx keeps the project up to date by itself — conflicts are resolved by
 * the agent, checked and committed, undo one click away; `review` = the same work, but shown for review before it
 * counts and landed by the human. Auto is the default (owner decision, 2026-09-19).
 */
export const integrationSchema = z.enum(['auto', 'review']);
export type Integration = z.infer<typeof integrationSchema>;

export const envShareSchema = z.enum(['per-grant', 'always', 'never']);
export type EnvShare = z.infer<typeof envShareSchema>;

/** App-wide (per machine) settings; stored in `app_settings`. */
/**
 * The workspace's instruments (ADR-0027 §2, #138, #140), by their stored keys: `design` is Preview (the running app;
 * the key predates the Design tab) and `canvas` is Design.
 */
export const INSTRUMENTS = ['tasks', 'canvas', 'design', 'changes', 'code', 'terminal'] as const;
export const instrumentSchema = z.enum(INSTRUMENTS);
export type Instrument = z.infer<typeof instrumentSchema>;

/** A stored order made whole: unknown and repeated entries dropped, instruments it lacks appended in default order. */
export const instrumentOrderOf = (order: readonly string[]): Instrument[] => {
  const out: Instrument[] = [];
  for (const k of order) {
    const known = INSTRUMENTS.find((i) => i === k);
    if (known !== undefined && !out.includes(known)) out.push(known);
  }
  for (const i of INSTRUMENTS) if (!out.includes(i)) out.push(i);
  return out;
};

export const appSettingsSchema = z.object({
  theme: themePreferenceSchema,
  notify: notifyModeSchema,
  launchAtLogin: z.boolean(),
  openFilesIn: z.enum(['styx', 'fallback']),
  fallbackIde: ideKindSchema.nullable(),
  autoWorktreePerAgent: z.boolean(),
  injectAs: z.enum(['scoped-else-env', 'env']),
  screenReader: z.boolean(),
  dnd: z.boolean(),
  onboardingDone: z.boolean(),
  /**
   * Watch agent worktrees for edits (hunks in the editor, the hunk bar, Diff review). Off by default (owner request:
   * with ~100 hunks the watcher and its deltas slowed the whole app); the demo fixture turns it on.
   */
  trackAgentEdits: z.boolean().default(false),
  /**
   * Send anonymous usage counts to Styx (ADR-0026 addendum, discrepancy #114): which features get reached, so
   * the product can be improved. A closed set of event names and nothing else — never a project, a path, a
   * branch or anything an agent said. On by default, off in one click; signed out, counted under a random
   * install id rather than an account (#122).
   */
  usageReports: z.boolean().default(true),
  /** The first-run walkthrough (owner request, #124) was finished or skipped; replayable from the palette. */
  tourDone: z.boolean().default(false),
  /**
   * Which walkthrough was seen (ADR-0027): a new layout gets a new walkthrough, offered once again to everyone
   * who saw an older one. 0 for anyone who saw only the first.
   */
  tourVersion: z.number().int().nonnegative().default(0),
  /** The workspace tabs in the person's order (#140); empty = the default order. Kept for every project. */
  instrumentOrder: z.array(z.string()).max(12).default([]),
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: 'system',
  notify: 'badge-sound',
  launchAtLogin: true,
  openFilesIn: 'styx',
  fallbackIde: null,
  autoWorktreePerAgent: true,
  injectAs: 'scoped-else-env',
  screenReader: false,
  dnd: false,
  onboardingDone: false,
  trackAgentEdits: false,
  usageReports: true,
  tourDone: false,
  tourVersion: 0,
  instrumentOrder: [],
};

/** The walkthrough for the current layout (ADR-0027: 2, organised around the lane). */
export const TOUR_VERSION = 2;

/** Whether this walkthrough has been finished or skipped; an older one does not count. */
export const tourSeen = (app: Pick<AppSettings, 'tourDone' | 'tourVersion'>): boolean =>
  app.tourDone && app.tourVersion >= TOUR_VERSION;

/**
 * Per-project settings: the merge of builtin defaults, app-level defaults, and `.styx/project.json`.
 * Flattened so each key can carry a `source` (drives the Settings reset affordance).
 */
export const projectSettingsSchema = z.object({
  defaultAgent: agentSchema,
  model: z.string().nullable(),
  permissionMode: permissionModeSchema,
  /**
   * The mode Styx's own tasks run in — Run locally, Deploy, Tech debt audit, the merge resolver (owner decision):
   * bounded jobs Styx started, so they run without asking unless the person says otherwise.
   */
  taskPermissionMode: permissionModeSchema,
  effort: effortSchema.nullable(),
  autoApproveEdits: z.boolean(),
  mayRequestTargets: z.boolean(),
  notifyWhenNeedsMe: z.boolean(),
  baseBranch: z.string().min(1),
  /** Keep lanes current (ADR-0023): fetch before cutting a lane; merge the base branch in before push / PR. */
  syncOnSpawn: z.boolean(),
  syncBeforePublish: z.boolean(),
  /**
   * Lanes that know about each other (ADR-0025): `autoSync` brings the base in at every turn boundary (small
   * merges, few conflicts) — the agent is idle then, so nothing lands under a write; `hotspots` are files one
   * lane should own at a time (globs; [] = the built-in list, `DEFAULT_HOTSPOTS`), warned about more loudly.
   */
  autoSync: autoSyncSchema,
  hotspots: z.array(z.string()),
  integration: integrationSchema,
  /** Auto mode only (ADR-0025 phase C): land a lane by itself when its session finishes and the checks pass. Off until trusted. */
  autoLand: z.boolean(),
  /**
   * What proves the work is good (`pnpm typecheck && pnpm test` …): run in the lane before a landing merges and
   * before a resolved merge is committed. Learned by the agent the first time (`remember_command` kind `checks`,
   * asked at the first landing — issue #2), editable in Settings › Agent defaults and as `checks.command` in
   * `.styx/project.json`; null = not known yet.
   */
  checksCommand: z.string().nullable(),
  branchPrefix: z.string(),
  worktreeLocation: worktreeLocationSchema,
  shellWindows: windowsShellSchema,
  lineEndings: lineEndingsSchema,
  envFiles: z.array(z.string()),
  envShareWithAgents: envShareSchema,
  /**
   * The project's dev-server URL, shown in the design window. Lives with the project settings (so it reaches
   * `.styx/project.json` and the whole team) because it describes the project, not the machine.
   */
  devUrl: z.string().nullable(),
  /** The command "Run locally" runs in the main worktree (`pnpm dev` …); detected from the repo when unset. */
  devCommand: z.string().nullable(),
  /** What the command runs on: a web server (design window loads `devUrl`) or a simulator the window mirrors. Null = web. */
  devPlatform: devPlatformSchema.nullable(),
  /** The simulator / emulator by name (`iPhone 17 Pro`), resolved per machine; null = Styx picks one. */
  devDevice: z.string().nullable(),
  /** The app's bundle id / package name, for launching and screenshots of the right app; null = whatever the command started. */
  devAppId: z.string().nullable(),
});
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  defaultAgent: 'claude',
  model: null,
  // Auto (owner decision 2026-10-03): asking before every command made a first task stop at nearly every step.
  // Claude decides what needs approval and Codex's reviewer does; Gemini edits freely and asks for commands; Cursor
  // still asks. Ask each time stays one click away in the composer and in Settings.
  permissionMode: 'auto',
  taskPermissionMode: 'bypassPermissions',
  effort: null,
  autoApproveEdits: false,
  mayRequestTargets: true,
  notifyWhenNeedsMe: true,
  baseBranch: 'main',
  syncOnSpawn: true,
  syncBeforePublish: true,
  autoSync: 'turn',
  hotspots: [],
  integration: 'auto',
  autoLand: false,
  checksCommand: null,
  branchPrefix: 'agent/',
  worktreeLocation: 'sibling',
  shellWindows: 'powershell',
  lineEndings: 'auto',
  envFiles: ['.env.local'],
  envShareWithAgents: 'per-grant',
  devUrl: null,
  devCommand: null,
  devPlatform: null,
  devDevice: null,
  devAppId: null,
};

export const settingsSourceSchema = z.enum(['default', 'app', 'project']);
export type SettingsSource = z.infer<typeof settingsSourceSchema>;

export type SettingsValue<T> = { value: T; source: SettingsSource };
export type EffectiveProjectSettings = { [K in keyof ProjectSettings]: SettingsValue<ProjectSettings[K]> };

/**
 * Device presets for the design window. `desktop` disables emulation entirely (the view simply fills its pane);
 * the others emulate a viewport so a responsive layout can be checked without leaving Styx.
 */
export const previewDeviceSchema = z.enum(['desktop', 'tablet', 'phone']);
export type PreviewDevice = z.infer<typeof previewDeviceSchema>;

export const PREVIEW_DEVICES: readonly PreviewDevice[] = previewDeviceSchema.options;

/** CSS pixel viewports for the emulated presets (iPad Air and iPhone 14 Pro, the common check sizes). */
export const PREVIEW_VIEWPORTS: Record<
  Exclude<PreviewDevice, 'desktop'>,
  { width: number; height: number }
> = {
  tablet: { width: 834, height: 1112 },
  phone: { width: 393, height: 852 },
};

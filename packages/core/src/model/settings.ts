import { z } from 'zod';
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

export const envShareSchema = z.enum(['per-grant', 'always', 'never']);
export type EnvShare = z.infer<typeof envShareSchema>;

/** App-wide (per machine) settings; stored in `app_settings`. */
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
};

/**
 * Per-project settings: the merge of builtin defaults, app-level defaults, and `.styx/project.json`.
 * Flattened so each key can carry a `source` (drives the Settings reset affordance).
 */
export const projectSettingsSchema = z.object({
  defaultAgent: agentSchema,
  model: z.string().nullable(),
  permissionMode: permissionModeSchema,
  effort: effortSchema.nullable(),
  autoApproveEdits: z.boolean(),
  mayRequestTargets: z.boolean(),
  notifyWhenNeedsMe: z.boolean(),
  baseBranch: z.string().min(1),
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
});
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  defaultAgent: 'claude',
  model: null,
  permissionMode: 'default',
  effort: null,
  autoApproveEdits: false,
  mayRequestTargets: true,
  notifyWhenNeedsMe: true,
  baseBranch: 'main',
  branchPrefix: 'agent/',
  worktreeLocation: 'sibling',
  shellWindows: 'powershell',
  lineEndings: 'auto',
  envFiles: ['.env.local'],
  envShareWithAgents: 'per-grant',
  devUrl: null,
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
export const PREVIEW_VIEWPORTS: Record<Exclude<PreviewDevice, 'desktop'>, { width: number; height: number }> = {
  tablet: { width: 834, height: 1112 },
  phone: { width: 393, height: 852 },
};

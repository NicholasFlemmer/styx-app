import { copy } from '@styx/core';

/**
 * Settings nav (spec §4.6): App group + Project group. Ids are qualified so a stale or foreign
 * `ui.settingsSection` value falls back to the prototype's initial section (Targets).
 */
export const APP_SECTIONS = [
  'app:general',
  'app:editor',
  'app:agents',
  'app:skills',
  'app:keychain',
  'app:policies',
  'app:shortcuts',
] as const;
export const PROJECT_SECTIONS = ['project:targets', 'project:agent-defaults', 'project:env'] as const;

export type AppSection = (typeof APP_SECTIONS)[number];
export type ProjectSection = (typeof PROJECT_SECTIONS)[number];
export type SettingsSection = AppSection | ProjectSection;

/** Prototype state script: `settingsNav: 'Targets'`. */
export const DEFAULT_SETTINGS_SECTION: SettingsSection = 'project:targets';

export const SECTION_LABEL: Record<SettingsSection, string> = {
  'app:general': copy.settings.app.general,
  'app:editor': copy.settings.app.editor,
  'app:agents': copy.agentsPage.title,
  'app:skills': copy.skills.title,
  'app:keychain': copy.settings.app.keychain,
  'app:policies': copy.settings.app.policies,
  'app:shortcuts': copy.settings.app.shortcuts,
  'project:targets': copy.settings.project.targets,
  'project:agent-defaults': copy.settings.project.agentDefaults,
  'project:env': copy.settings.project.env,
};

export const isSettingsSection = (v: string): v is SettingsSection =>
  (APP_SECTIONS as readonly string[]).includes(v) || (PROJECT_SECTIONS as readonly string[]).includes(v);

export const resolveSection = (v: string): SettingsSection =>
  isSettingsSection(v) ? v : DEFAULT_SETTINGS_SECTION;

export const isProjectSection = (s: SettingsSection): s is ProjectSection =>
  (PROJECT_SECTIONS as readonly string[]).includes(s);

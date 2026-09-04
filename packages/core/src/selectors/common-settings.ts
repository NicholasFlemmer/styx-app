import type { ProjectId } from '../ids';
import { DEFAULT_PROJECT_SETTINGS, type ProjectSettings } from '../model/settings';
import type { ReadModel } from '../read-model';

export * from './common';

/** Effective project settings flattened to values, falling back to builtin defaults. */
export const projectSettingsOfOrDefault = (model: ReadModel, projectId: ProjectId): ProjectSettings => {
  const eff = model.settings.project[projectId];
  if (eff === undefined) return DEFAULT_PROJECT_SETTINGS;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(eff) as (keyof ProjectSettings)[]) out[key] = eff[key].value;
  return out as ProjectSettings;
};

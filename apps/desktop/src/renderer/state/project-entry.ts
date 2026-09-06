import { copy, type ProjectId } from '@styx/core';
import { command } from './commands';
import { useUiStore } from './ui-store';

/** Select a project and land in its Workspace (Home row click, Open folder, Clone). */
export const enterProject = (projectId: ProjectId): void => {
  const ui = useUiStore.getState();
  ui.setProject(projectId);
  void command('project.select', { projectId });
  ui.setScreen('workspace');
};

/**
 * "Open folder…" everywhere (Home add row / empty state, rail menu, palette): OS folder picker → `project.add`
 * → Workspace. Returns the project id, or null when the picker was dismissed or the add failed (toast already shown).
 */
export const openFolderAsProject = async (): Promise<ProjectId | null> => {
  const picked = await command('dialog.pickFolder', { title: copy.rail.menu.openFolder.replace(/…$/, '') });
  if (!picked.ok || picked.value.path === null) return null;
  const added = await command('project.add', { path: picked.value.path });
  const projectId = added.ok ? (added.value.projectId ?? null) : null;
  if (projectId !== null) enterProject(projectId);
  return projectId;
};

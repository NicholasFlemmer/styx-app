import {
  activeGrants,
  copy,
  fill,
  projectBranchOrNull,
  projectNameOf,
  projectOf,
  rows,
  sessionsInProject,
  type ReadModel,
} from '@styx/core';
import { NavItem } from '@styx/ui';
import { useCallback } from 'react';
import { useModel, useNow, useUi } from '../state/hooks';
import { startDebtAudit } from '../features/audit';
import { isProjectSection, resolveSection } from '../screens/Settings/sections';
import type { Screen } from '../state/ui-store';
import s from './Shell.module.css';

interface NavRow {
  screen: Screen;
  label: string;
  meta: string | null;
}

/**
 * Project nav (spec §3, owner layout #85): everything here belongs to the selected project. The head is the
 * project's details (name, branch), the rows its places (Workspace, Agents, Repo, Project settings), then the
 * project's own actions (Tech debt audit), and the footer its path and active grants. App-level places (All
 * projects, Approvals, Tasks, App settings) live on the app rail to the left of the project switcher.
 */
export function Nav() {
  const projectId = useUi((u) => u.projectId);
  const screen = useUi((u) => u.screen);
  const setScreen = useUi((u) => u.setScreen);
  const settingsSection = useUi((u) => u.settingsSection);
  const setSettingsSection = useUi((u) => u.setSettingsSection);
  const now = useNow();
  const model = useModel(useCallback((m: ReadModel) => m, []));

  const project = projectId === null ? null : projectOf(model, projectId);
  const projectName = projectId === null ? copy.general.none : projectNameOf(model, projectId);
  const branch = projectId === null ? null : projectBranchOrNull(model, projectId);
  const agents =
    projectId === null ? 0 : sessionsInProject(model, projectId).filter((x) => x.state !== 'done').length;
  const worktrees =
    projectId === null
      ? 0
      : rows(model.worktrees).filter((w) => w.projectId === projectId && w.archivedAt === null).length;
  const grants = activeGrants(model, now).length;
  const onProjectSettings = screen === 'settings' && isProjectSection(resolveSection(settingsSection));

  const items: NavRow[] = [
    { screen: 'workspace', label: copy.nav.workspace, meta: null },
    { screen: 'agents', label: copy.nav.agents, meta: String(agents) },
    { screen: 'repo', label: copy.nav.repo, meta: fill(copy.nav.worktreesMeta, { n: worktrees }) },
  ];

  const openProjectSettings = () => {
    // The nav's Settings are the project's: an app section left over from the app rail is swapped for Targets.
    if (!isProjectSection(resolveSection(settingsSection))) setSettingsSection('project:targets');
    setScreen('settings');
  };

  return (
    <nav className={s['nav']} aria-label="Sections" data-nav="true">
      <div className={['t-label', s['navHead']].join(' ')}>{projectName}</div>
      {branch !== null && branch !== '' ? (
        <div className={s['navBranch']} data-nav-branch="true">
          <span className="visually-hidden">{copy.appRail.branch} </span>
          {branch}
        </div>
      ) : null}
      {items.map((it) => (
        <NavItem
          key={it.screen}
          label={it.label}
          meta={it.meta}
          inv={screen === it.screen}
          onClick={() => setScreen(it.screen)}
          data-nav-item={it.screen}
        />
      ))}
      <NavItem
        label={copy.nav.projectSettings}
        inv={onProjectSettings}
        onClick={openProjectSettings}
        data-nav-item="settings"
      />
      <NavItem
        label={copy.debtAudit.action}
        disabled={projectId === null}
        onClick={() => {
          if (projectId) void startDebtAudit(model, projectId);
        }}
        data-nav-audit="true"
      />
      <div className={s['navFoot']}>
        {project?.path ?? copy.general.none}
        <br />
        {fill(copy.counters.statusGrantsActive, { n: grants })}
      </div>
    </nav>
  );
}

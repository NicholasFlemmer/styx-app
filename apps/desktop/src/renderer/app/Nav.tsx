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
import { NavItem, type IconName } from '@styx/ui';
import { useCallback } from 'react';
import { useModel, useNow, useUi } from '../state/hooks';
import { startDebtAudit } from '../features/audit';
import {
  PROJECT_SECTIONS,
  SECTION_LABEL,
  resolveSection,
  type ProjectSection,
} from '../screens/Settings/sections';
import type { Screen } from '../state/ui-store';
import s from './Shell.module.css';

/** The icon each project option wears. */
const PROJECT_SECTION_ICON: Record<ProjectSection, IconName> = {
  'project:targets': 'targets',
  'project:agent-defaults': 'agentDefaults',
  'project:env': 'env',
};

interface NavRow {
  screen: Screen;
  icon: IconName;
  label: string;
  meta: string | null;
}

/**
 * Project nav (spec §3, owner layout #85): everything here belongs to the selected project. The head is the
 * project's details (name, branch), the rows its places (Workspace, Agents, Repo) and its options (Targets, Agent
 * defaults, Env — rows, not a Settings tab), then its own action (Tech debt audit), and the footer its path and
 * active grants. App-level places (All
 * projects, Approvals, Tasks, App settings) live on the app rail to the left of the project switcher.
 */
export function Nav() {
  const projectId = useUi((u) => u.projectId);
  const screen = useUi((u) => u.screen);
  const setScreen = useUi((u) => u.setScreen);
  const settingsSection = useUi((u) => u.settingsSection);
  const setSettingsSection = useUi((u) => u.setSettingsSection);
  const boardScope = useUi((u) => u.boardScope);
  const setBoardScope = useUi((u) => u.setBoardScope);
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
  const section = resolveSection(settingsSection);

  const items: NavRow[] = [
    { screen: 'workspace', icon: 'workspace', label: copy.nav.workspace, meta: null },
    { screen: 'agents', icon: 'agents', label: copy.nav.agents, meta: String(agents) },
    {
      screen: 'repo',
      icon: 'repo',
      label: copy.nav.repo,
      meta: fill(copy.nav.worktreesMeta, { n: worktrees }),
    },
  ];

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
          icon={it.icon}
          label={it.label}
          meta={it.meta}
          inv={screen === it.screen && (it.screen !== 'agents' || boardScope === 'project')}
          onClick={() => {
            // The project's agents, not everyone's (the app rail's Agents tile shows all).
            if (it.screen === 'agents') setBoardScope('project');
            setScreen(it.screen);
          }}
          data-nav-item={it.screen}
        />
      ))}
      {/* The project's options are rows here, not a tab (owner request #88): Targets · Agent defaults · Env. */}
      {PROJECT_SECTIONS.map((id) => (
        <NavItem
          key={id}
          icon={PROJECT_SECTION_ICON[id]}
          label={SECTION_LABEL[id]}
          inv={screen === 'settings' && section === id}
          onClick={() => {
            setSettingsSection(id);
            setScreen('settings');
          }}
          data-nav-item={id}
        />
      ))}
      <NavItem
        icon="audit"
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

import {
  activeGrants,
  copy,
  fill,
  navLanes,
  navLanesLabel,
  projectBranchOrNull,
  projectNameOf,
  projectOf,
  rows,
  sessionsInProject,
  type ReadModel,
} from '@styx/core';
import { LaneRow, NavItem, type IconName } from '@styx/ui';
import { useCallback } from 'react';
import { useModel, useNow, useSessionId, useUi } from '../state/hooks';
import { startDebtAudit } from '../features/audit';
import {
  PROJECT_SECTIONS,
  SECTION_LABEL,
  resolveSection,
  type ProjectSection,
} from '../screens/Settings/sections';
import s from './Shell.module.css';

/** The icon each project option wears. */
const PROJECT_SECTION_ICON: Record<ProjectSection, IconName> = {
  'project:targets': 'targets',
  'project:agent-defaults': 'agentDefaults',
  'project:env': 'env',
};

/**
 * Project nav (ADR-0027 §1): the work first, then the project's tools. The head is the project (a button back to
 * its workspace) and its branch. "Work" lists every lane by its task and whose move it is, most urgent first,
 * with New task under it. "Project" holds what used to be the whole nav: Lanes and branches (the Repo screen),
 * the project's Agents board, Targets, Agent defaults, Env and secrets, and the Tech debt audit. The footer keeps
 * the path and the open grants.
 */
export function Nav() {
  const projectId = useUi((u) => u.projectId);
  const screen = useUi((u) => u.screen);
  const setScreen = useUi((u) => u.setScreen);
  const openSession = useUi((u) => u.openSession);
  const openNewTask = useUi((u) => u.openNewTask);
  const newTask = useUi((u) => u.newTask);
  const settingsSection = useUi((u) => u.settingsSection);
  const setSettingsSection = useUi((u) => u.setSettingsSection);
  const boardScope = useUi((u) => u.boardScope);
  const setBoardScope = useUi((u) => u.setBoardScope);
  const now = useNow();
  const model = useModel(useCallback((m: ReadModel) => m, []));
  const activeSessionId = useSessionId();

  const project = projectId === null ? null : projectOf(model, projectId);
  const projectName = projectId === null ? copy.general.none : projectNameOf(model, projectId);
  const branch = projectId === null ? null : projectBranchOrNull(model, projectId, activeSessionId);
  const lanes = projectId === null ? [] : navLanes(model, projectId, now);
  const agents =
    projectId === null ? 0 : sessionsInProject(model, projectId).filter((x) => x.state !== 'done').length;
  const worktrees =
    projectId === null
      ? 0
      : rows(model.worktrees).filter((w) => w.projectId === projectId && w.archivedAt === null).length;
  const grants = activeGrants(model, now).length;
  const section = resolveSection(settingsSection);
  const newTaskHere = newTask !== null && newTask.projectId === projectId;
  // The lane is what the workspace shows unless New task has taken it.
  const inWorkspace = screen === 'workspace' && !newTaskHere;

  return (
    <nav className={s['nav']} aria-label="Sections" data-nav="true">
      <button
        type="button"
        className={s['navProject']}
        disabled={projectId === null}
        aria-current={inWorkspace && lanes.length === 0 ? 'page' : undefined}
        onClick={() => setScreen('workspace')}
        data-nav-item="workspace"
      >
        <span className={s['navHead']}>{projectName}</span>
        {branch !== null && branch !== '' ? (
          <span className={s['navBranch']} data-nav-branch="true">
            <span className="visually-hidden">{copy.appRail.branch} </span>
            {branch}
          </span>
        ) : null}
      </button>

      <div className={s['navGroup']} data-nav-group="work">
        <span>{copy.lanes.nav.work}</span>
        <span>{lanes.length === 0 ? '' : navLanesLabel(lanes.length)}</span>
      </div>
      <div className={s['navLanes']} role="list" aria-label={copy.lanes.nav.label} data-nav-lanes="true">
        {lanes.map((lane) => (
          <div role="listitem" key={lane.sessionId}>
            <LaneRow
              agent={lane.agent}
              task={lane.task}
              status={lane.statusLabel}
              tone={lane.status === 'your-turn' ? 'yours' : lane.status === 'landed' ? 'quiet' : 'normal'}
              inv={inWorkspace && lane.sessionId === activeSessionId}
              onClick={() => {
                if (projectId !== null) openSession(projectId, lane.sessionId);
              }}
              data-nav-lane={lane.sessionId}
              data-lane-status={lane.status}
            />
          </div>
        ))}
        {lanes.length === 0 ? <p className={s['navEmpty']}>{copy.lanes.nav.empty}</p> : null}
      </div>
      <button
        type="button"
        className={s['navNewTask']}
        disabled={projectId === null}
        aria-current={newTaskHere && screen === 'workspace' ? 'page' : undefined}
        onClick={() => {
          if (projectId !== null) openNewTask(projectId);
        }}
        data-nav-new-task="true"
      >
        + {copy.lanes.nav.newTask}
      </button>

      <div className={s['navGroup']} data-nav-group="project">
        <span>{copy.lanes.nav.project}</span>
      </div>
      <NavItem
        icon="repo"
        label={copy.lanes.nav.lanesAndBranches}
        meta={String(worktrees)}
        inv={screen === 'repo'}
        onClick={() => setScreen('repo')}
        data-nav-item="repo"
      />
      <NavItem
        icon="agents"
        label={copy.nav.agents}
        meta={String(agents)}
        inv={screen === 'agents' && boardScope === 'project'}
        onClick={() => {
          // The project's agents, not everyone's (the rail's Agents place shows all).
          setBoardScope('project');
          setScreen('agents');
        }}
        data-nav-item="agents"
      />
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

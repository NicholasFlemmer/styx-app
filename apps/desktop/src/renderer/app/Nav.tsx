import {
  activeGrants,
  backgroundTasks,
  copy,
  fill,
  inboxRows,
  projectCount,
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
import { openTask } from '../features/tasks/task-launch';
import type { Screen } from '../state/ui-store';
import s from './Shell.module.css';

interface NavRow {
  screen: Screen;
  label: string;
  meta: string | null;
}

/** Nav (spec §3): six items with right-aligned mono meta; footer shows the project path and active grants. */
export function Nav() {
  const projectId = useUi((u) => u.projectId);
  const screen = useUi((u) => u.screen);
  const setScreen = useUi((u) => u.setScreen);
  const now = useNow();
  const model = useModel(useCallback((m: ReadModel) => m, []));

  const project = projectId === null ? null : projectOf(model, projectId);
  const projectName = projectId === null ? copy.general.none : projectNameOf(model, projectId);
  const agents =
    projectId === null ? 0 : sessionsInProject(model, projectId).filter((x) => x.state !== 'done').length;
  const worktrees =
    projectId === null
      ? 0
      : rows(model.worktrees).filter((w) => w.projectId === projectId && w.archivedAt === null).length;
  const inbox = inboxRows(model, now).length;
  const grants = activeGrants(model, now).length;
  const tasks = backgroundTasks(model).filter((t) => t.state !== 'done');

  const items: NavRow[] = [
    { screen: 'home', label: copy.nav.home, meta: String(projectCount(model)) },
    { screen: 'workspace', label: copy.nav.workspace, meta: null },
    { screen: 'agents', label: copy.nav.agents, meta: String(agents) },
    { screen: 'repo', label: copy.nav.repo, meta: fill(copy.nav.worktreesMeta, { n: worktrees }) },
    { screen: 'approvals', label: copy.nav.approvals, meta: String(inbox) },
    { screen: 'settings', label: copy.nav.settings, meta: null },
  ];

  return (
    <nav className={s['nav']} aria-label="Sections" data-nav="true">
      <div className={['t-label', s['navHead']].join(' ')}>{projectName}</div>
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
        label={copy.debtAudit.action}
        disabled={projectId === null}
        onClick={() => {
          if (projectId) void startDebtAudit(model, projectId);
        }}
        data-nav-audit="true"
      />
      <NavItem
        label={copy.tasks.title}
        meta={String(tasks.length)}
        on={tasks.some((t) => t.state === 'needs-you')}
        onClick={() => openTask(null)}
        data-nav-tasks="true"
      />
      <div className={s['navFoot']}>
        {project?.path ?? copy.general.none}
        <br />
        {fill(copy.counters.statusGrantsActive, { n: grants })}
      </div>
    </nav>
  );
}

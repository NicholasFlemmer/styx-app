import {
  activeGrants,
  copy,
  homeActivity,
  homeGreeting,
  homeProjectRows,
  homeSummary,
  needsYouCount,
  readyToLandCount,
  workingCount,
  type ProjectId,
  type ReadModel,
  type SessionId,
} from '@styx/core';
import { Button, CounterStrip, CounterTile, EmptyState } from '@styx/ui';
import { useCallback } from 'react';
import { command } from '../../state/commands';
import { useModel, useNow, useUi } from '../../state/hooks';
import { openFolderAsProject } from '../../state/project-entry';
import { ActivityFeed } from './ActivityFeed';
import s from './Home.module.css';
import { ProjectTable } from './ProjectTable';

const selectNeedsYou = (m: ReadModel) => needsYouCount(m);
const selectWorking = (m: ReadModel) => workingCount(m);
const selectReady = (m: ReadModel) => readyToLandCount(m);
const selectName = (m: ReadModel) => (m.account.kind === 'signed-in' ? m.account.account.name : null);

/**
 * Home / All projects (spec §4.2, ADR-0027): a greeting and what is going on in one line, with Add a project and
 * New task; the counters (needs you, working, ready to land, grants open); every project with its lanes; the add
 * row; what happened.
 */
export function Home() {
  const now = useNow();
  const setProject = useUi((u) => u.setProject);
  const setScreen = useUi((u) => u.setScreen);
  const pushOverlay = useUi((u) => u.pushOverlay);

  const needsYou = useModel(selectNeedsYou);
  const working = useModel(selectWorking);
  const ready = useModel(selectReady);
  const name = useModel(selectName);
  const openSession = useUi((u) => u.openSession);
  const openNewTask = useUi((u) => u.openNewTask);
  const currentProject = useUi((u) => u.projectId);
  const grants = useModel(useCallback((m: ReadModel) => activeGrants(m, now).length, [now]));
  const rows = useModel(useCallback((m: ReadModel) => homeProjectRows(m, now), [now]));
  const activity = useModel(useCallback((m: ReadModel) => homeActivity(m, now), [now]));

  const openProject = (projectId: ProjectId) => {
    setProject(projectId);
    void command('project.select', { projectId });
    setScreen('workspace');
  };
  const openNewProject = () => pushOverlay({ kind: 'modal', modal: 'new-project' });
  const openClone = () => pushOverlay({ kind: 'modal', modal: 'new-project', mode: 'clone' });
  /** OS folder picker → `project.add` → the new project's Workspace (nothing happens when dismissed). */
  const openFolder = () => {
    void openFolderAsProject();
  };
  /** Recents + scanned repos with checkboxes (the onboarding step-2 list, any time). */
  const addExisting = () => pushOverlay({ kind: 'modal', modal: 'add-existing' });

  const empty = rows.length === 0;

  return (
    <div className={s['home']} data-home-empty={empty ? 'true' : undefined}>
      <header className={s['hello']}>
        <div>
          <h2 className={s['title']}>{homeGreeting(new Date(now).getHours(), name)}</h2>
          <p className={s['summary']}>{homeSummary(needsYou, working)}</p>
        </div>
        <div className={s['helloActs']}>
          {empty ? null : (
            <Button
              variant="accent"
              onClick={() => openNewTask(currentProject ?? rows[0]?.projectId ?? null)}
              data-home-new-task="true"
            >
              {copy.home.newTask}
            </Button>
          )}
        </div>
      </header>
      <CounterStrip columns={4} data-home-counters="true">
        {/* Not live: the titlebar counter already announces needs-you changes (one live region, spec §9). */}
        <CounterTile value={needsYou} label={copy.counters.needsYou} attention={needsYou > 0} />
        <CounterTile value={working} label={copy.counters.agentsWorking} />
        <CounterTile value={ready} label={copy.home.readyToLand} />
        <CounterTile value={grants} label={copy.counters.grantsActive} />
      </CounterStrip>

      <ProjectTable
        rows={rows}
        onOpen={openProject}
        onOpenLane={(projectId: ProjectId, sessionId: SessionId) => openSession(projectId, sessionId)}
        onNewTask={(projectId: ProjectId) => openNewTask(projectId)}
      />
      {empty ? (
        <EmptyState
          headline={copy.empty.projects.headline}
          body={copy.empty.projects.bodyPrototype}
          actions={
            <>
              <Button variant="primary" onClick={addExisting}>
                {copy.empty.projects.scan}
              </Button>
              <Button onClick={openNewProject}>{copy.empty.projects.newProject}</Button>
              <Button onClick={() => void openFolder()}>{copy.empty.projects.openFolder}</Button>
              <Button onClick={openClone}>{copy.empty.projects.cloneUrl}</Button>
            </>
          }
        />
      ) : null}

      <div className={s['addRow']}>
        <Button variant="dashed" size="regular" onClick={openNewProject}>
          {copy.home.addRow.newProject}
        </Button>
        <Button variant="dashed" size="regular" onClick={addExisting}>
          {copy.home.addRow.addExisting}
        </Button>
        <Button variant="dashed" size="regular" onClick={() => void openFolder()}>
          {copy.home.addRow.openFolder}
        </Button>
        <Button variant="dashed" size="regular" onClick={openClone}>
          {copy.home.addRow.cloneUrl}
        </Button>
      </div>

      <ActivityFeed rows={activity} />
    </div>
  );
}

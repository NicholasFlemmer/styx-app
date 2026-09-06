import {
  activeGrants,
  copy,
  homeActivity,
  homeProjectRows,
  needsYouCount,
  projectCount,
  workingCount,
  type ProjectId,
  type ReadModel,
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
const selectProjects = (m: ReadModel) => projectCount(m);

/** Home / All projects (spec §4.2): counter strip → project table (or empty state) → add row → activity feed. */
export function Home() {
  const now = useNow();
  const setProject = useUi((u) => u.setProject);
  const setScreen = useUi((u) => u.setScreen);
  const pushOverlay = useUi((u) => u.pushOverlay);

  const needsYou = useModel(selectNeedsYou);
  const working = useModel(selectWorking);
  const projects = useModel(selectProjects);
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
  const openFolder = () => openFolderAsProject();
  const scan = () => void command('project.scan', { includeIdeRecents: true });

  const empty = rows.length === 0;

  return (
    <div className={s['home']} data-home-empty={empty ? 'true' : undefined}>
      <CounterStrip columns={4}>
        {/* Not live: the titlebar counter already announces needs-you changes (one live region, spec §9). */}
        <CounterTile value={needsYou} label={copy.counters.needsYou} />
        <CounterTile value={working} label={copy.counters.agentsWorking} />
        <CounterTile value={grants} label={copy.counters.grantsActive} />
        <CounterTile value={projects} label={copy.counters.projects} />
      </CounterStrip>

      <ProjectTable rows={rows} onOpen={openProject} />
      {empty ? (
        <EmptyState
          headline={copy.empty.projects.headline}
          body={copy.empty.projects.bodyPrototype}
          actions={
            <>
              <Button variant="primary" onClick={scan}>
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

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
import { ActivityFeed } from './ActivityFeed';
import s from './Home.module.css';
import { ProjectTable } from './ProjectTable';

const selectNeedsYou = (m: ReadModel) => needsYouCount(m);
const selectWorking = (m: ReadModel) => workingCount(m);
const selectProjects = (m: ReadModel) => projectCount(m);

/**
 * TODO(main): the contract has no folder-picker command yet (`project.pickFolder` → dialog.showOpenDialog in main).
 * Until it exists this resolves to null and "Open folder" dispatches nothing; `project.add` is wired for the path.
 */
const pickFolder = async (): Promise<string | null> => null;

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
  // TODO(overlays): `ModalPayload` has no clone mode yet; the new-project modal opens in its default mode.
  const openClone = () => pushOverlay({ kind: 'modal', modal: 'new-project' });
  const openFolder = async () => {
    const path = await pickFolder();
    if (path !== null) await command('project.add', { path });
  };
  const scan = () => void command('project.scan', { includeIdeRecents: true });

  const empty = rows.length === 0;

  return (
    <div className={s['home']} data-home-empty={empty ? 'true' : undefined}>
      <CounterStrip columns={4}>
        <CounterTile value={needsYou} label={copy.counters.needsYou} live />
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

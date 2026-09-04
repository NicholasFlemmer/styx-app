import { rows, sessionsInProject, type Project, type ProjectId, type ReadModel } from '@styx/core';
import { RailTile } from '@styx/ui';
import { useCallback, useRef, type DragEvent } from 'react';
import { command } from '../state/commands';
import { useModel, useUi } from '../state/hooks';
import s from './Shell.module.css';

export const railProjects = (m: ReadModel): Project[] =>
  rows(m.projects)
    .filter((p) => p.removedAt === null)
    .sort((a, b) => a.railOrder - b.railOrder);

const needsByProject = (m: ReadModel, projectId: ProjectId): boolean =>
  sessionsInProject(m, projectId).some((x) => x.state === 'needs-you');

/** Project rail (spec §3): 36px tiles ordered by `railOrder`, accent corner when a session needs you, drag to reorder. */
export function Rail() {
  const projects = useModel(railProjects);
  const model = useModel(useCallback((m: ReadModel) => m, []));
  const projectId = useUi((u) => u.projectId);
  const setProject = useUi((u) => u.setProject);
  const setScreen = useUi((u) => u.setScreen);
  const screen = useUi((u) => u.screen);
  const pushOverlay = useUi((u) => u.pushOverlay);
  const dragId = useRef<ProjectId | null>(null);

  const pick = (id: ProjectId) => {
    setProject(id);
    if (screen === 'home') setScreen('workspace');
    void command('project.select', { projectId: id });
  };

  const onDrop = (e: DragEvent<HTMLButtonElement>, over: ProjectId) => {
    e.preventDefault();
    const from = dragId.current;
    dragId.current = null;
    if (from === null || from === over) return;
    const order = projects.map((p) => p.id).filter((id) => id !== from);
    const at = order.indexOf(over);
    order.splice(at < 0 ? order.length : at, 0, from);
    void command('project.reorder', { projectIds: order });
  };

  return (
    <nav className={s['rail']} aria-label="Projects" data-rail="true">
      {projects.map((p) => (
        <RailTile
          key={p.id}
          initials={p.initials}
          title={p.name}
          active={p.id === projectId}
          needs={needsByProject(model, p.id)}
          onClick={() => pick(p.id)}
          draggable
          onDragStart={(e) => {
            dragId.current = p.id;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', p.id);
          }}
          onDragOver={(e) => {
            if (dragId.current !== null) e.preventDefault();
          }}
          onDrop={(e) => onDrop(e, p.id)}
          onDragEnd={() => {
            dragId.current = null;
          }}
          data-project-id={p.id}
        />
      ))}
      <RailTile
        variant="add"
        title="New project"
        onClick={() => pushOverlay({ kind: 'modal', modal: 'new-project' })}
      />
    </nav>
  );
}

import { rows, sessionsInProject, type Project, type ProjectId, type ReadModel } from '@styx/core';
import { RailTile } from '@styx/ui';
import { useCallback, useRef, type DragEvent, type KeyboardEvent } from 'react';
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

  /** Keyboard parity for drag-to-reorder (spec §9): Alt+↑ / Alt+↓ move the focused tile. */
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, id: ProjectId) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const order = projects.map((p) => p.id);
    const from = order.indexOf(id);
    const to = from + (e.key === 'ArrowUp' ? -1 : 1);
    if (from < 0 || to < 0 || to >= order.length) return;
    order.splice(from, 1);
    order.splice(to, 0, id);
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
          onKeyDown={(e) => onKeyDown(e, p.id)}
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

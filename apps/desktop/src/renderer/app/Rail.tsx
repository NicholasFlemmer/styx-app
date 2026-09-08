import { copy, rows, sessionsInProject, type Project, type ProjectId, type ReadModel } from '@styx/core';
import { RailTile } from '@styx/ui';
import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { command } from '../state/commands';
import { useModel, useUi } from '../state/hooks';
import { openFolderAsProject } from '../state/project-entry';
import s from './Shell.module.css';

/** Rail "+" menu rows (owner addition, docs/handoff-discrepancies #49). */
const ADD_MENU = ['newProject', 'addExisting', 'openFolder', 'cloneUrl'] as const;
type AddMenuItem = (typeof ADD_MENU)[number];

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
  const addRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // One fixed menu serves both the + tile (projectId null) and a project tile's right-click menu.
  const [menu, setMenu] = useState<{ top: number; left: number; projectId: ProjectId | null } | null>(
    null,
  );

  // The rail clips overflow, so the menu is fixed next to the + tile; outside clicks close it without focus return.
  useEffect(() => {
    if (menu === null) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || addRef.current?.contains(target)) return;
      setMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menu]);

  const openMenu = () => {
    if (menu !== null) {
      setMenu(null);
      return;
    }
    const r = addRef.current?.getBoundingClientRect();
    setMenu({ top: r?.top ?? 0, left: (r?.right ?? 0) + 6, projectId: null });
  };
  const closeMenu = (refocus: boolean) => {
    setMenu(null);
    if (refocus) addRef.current?.focus();
  };
  const choose = (item: AddMenuItem) => {
    closeMenu(true);
    if (item === 'newProject') pushOverlay({ kind: 'modal', modal: 'new-project' });
    else if (item === 'addExisting') pushOverlay({ kind: 'modal', modal: 'add-existing' });
    else if (item === 'cloneUrl') pushOverlay({ kind: 'modal', modal: 'new-project', mode: 'clone' });
    else void openFolderAsProject();
  };
  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(true);
      return;
    }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? items.length - 1
          : e.key === 'ArrowDown'
            ? (i + 1) % items.length
            : (i - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  /** Soft-removes the project (files are left on disk) and stops anything it was running. */
  const removeProject = (id: ProjectId) => {
    setMenu(null);
    void command('project.remove', { projectId: id, deleteFiles: false });
  };

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
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ top: e.clientY, left: e.clientX, projectId: p.id });
          }}
          data-project-id={p.id}
        />
      ))}
      <RailTile
        ref={addRef}
        variant="add"
        title={copy.rail.add}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={openMenu}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && menu === null) {
            e.preventDefault();
            openMenu();
          }
        }}
        data-rail-add="true"
      />
      {menu !== null ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label={menu.projectId !== null ? copy.rail.projectMenu : copy.rail.add}
          className={s['addMenu']}
          style={{ top: menu.top, left: menu.left }}
          onKeyDown={onMenuKeyDown}
          data-rail-add-menu="true"
        >
          {menu.projectId !== null ? (
            <button
              type="button"
              role="menuitem"
              className={s['addMenuItem']}
              onClick={() => removeProject(menu.projectId as ProjectId)}
              data-rail-remove="true"
            >
              {copy.rail.remove}
            </button>
          ) : (
            ADD_MENU.map((item) => (
              <button
                key={item}
                type="button"
                role="menuitem"
                className={s['addMenuItem']}
                onClick={() => choose(item)}
              >
                {copy.rail.menu[item]}
              </button>
            ))
          )}
        </div>
      ) : null}
    </nav>
  );
}

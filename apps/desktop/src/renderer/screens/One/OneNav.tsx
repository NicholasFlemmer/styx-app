import { copy, oneNeeds, oneProjects, type ReadModel } from '@styx/core';
import { command } from '../../state/commands';
import { useModel, useNow, useUi } from '../../state/hooks';
import type { Screen } from '../../state/ui-store';
import s from './One.module.css';

const identity = (m: ReadModel) => m;

const PLACES: [Screen, keyof typeof copy.one.nav][] = [
  ['one-home', 'home'],
  ['one-needs', 'needs'],
  ['one-tasks', 'tasks'],
  ['one-projects', 'projects'],
  ['one-results', 'results'],
  ['team', 'knowHow'],
  ['one-apps', 'apps'],
  ['one-record', 'record'],
];

/** The plain-words sidebar (ADR-0033): the places, then the projects, then Settings and the way back. */
export function OneNav() {
  const model = useModel(identity);
  const now = useNow();
  const screen = useUi((u) => u.screen);
  const projectId = useUi((u) => u.projectId);
  const setScreen = useUi((u) => u.setScreen);
  const setProject = useUi((u) => u.setProject);
  const needs = oneNeeds(model, now).length;
  const projects = oneProjects(model, now);
  const n = copy.one.nav;
  // A task's details (the workspace) belong to Tasks; the project page to its project below.
  const current = screen === 'workspace' || screen === 'diff' || screen === 'one-task' ? 'one-tasks' : screen;
  return (
    <nav className={s['side']} aria-label={copy.one.modeLabel} data-one-nav="true">
      {PLACES.map(([to, key]) => (
        <button
          key={to}
          type="button"
          className={s['sideLink']}
          data-inv={current === to ? 'true' : undefined}
          aria-current={current === to ? 'page' : undefined}
          onClick={() => setScreen(to)}
        >
          {n[key]}
          {to === 'one-needs' && needs > 0 ? <span className={s['count']}>{needs}</span> : null}
        </button>
      ))}
      <div className={s['sideGroup']}>{copy.one.projectsGroup}</div>
      {projects.map((p) => {
        const on = screen === 'one-project' && projectId === p.projectId;
        return (
          <button
            key={p.projectId}
            type="button"
            className={s['place']}
            data-inv={on ? 'true' : undefined}
            aria-current={on ? 'page' : undefined}
            onClick={() => {
              setProject(p.projectId);
              setScreen('one-project');
            }}
          >
            <span className={s['placeName']}>{p.name}</span>
            {p.needs > 0 ? <span className={s['count']}>{p.needs}</span> : null}
            <span className={s['placeCount']}>{p.tasks}</span>
          </button>
        );
      })}
      <div className={s['sideFoot']}>
        <button
          type="button"
          className={s['sideLink']}
          data-inv={screen === 'settings' ? 'true' : undefined}
          onClick={() => setScreen('settings')}
        >
          {n.settings}
        </button>
        <button
          type="button"
          className={s['sideLink']}
          onClick={() => void command('settings.set', { patch: { oneMode: false } })}
        >
          {n.classic}
        </button>
      </div>
    </nav>
  );
}

import { copy, fill, oneProjects, oneTasks, repoOf, rows, type ReadModel } from '@styx/core';
import { Button } from '@styx/ui';
import { useModel, useNow, useUi } from '../../state/hooks';
import { AskBox, TaskList } from './parts';
import s from './One.module.css';

const identity = (m: ReadModel) => m;

/** Projects (mockup frame 12's parent): a client or product each, with what is going on in it. */
export function OneProjects() {
  const model = useModel(identity);
  const now = useNow();
  const pushOverlay = useUi((u) => u.pushOverlay);
  const setProject = useUi((u) => u.setProject);
  const setScreen = useUi((u) => u.setScreen);
  const p = copy.one.projects;
  const list = oneProjects(model, now);
  return (
    <div className={s['page']} data-one-page="projects">
      <div className={s['head']}>
        <h1 className={s['title']}>{p.title}</h1>
        <Button
          size="regular"
          className={s['push']}
          onClick={() => pushOverlay({ kind: 'modal', modal: 'new-project' })}
        >
          {p.add}
        </Button>
      </div>
      {list.length === 0 ? (
        <p className={s['empty']}>{p.empty}</p>
      ) : (
        <ul className={s['cards']}>
          {list.map((x) => (
            <li key={x.projectId}>
              <button
                type="button"
                className={s['card']}
                data-one-project={x.projectId}
                onClick={() => {
                  setProject(x.projectId);
                  setScreen('one-project');
                }}
              >
                <span className={s['cardTitle']}>{x.name}</span>
                <span className={s['facts']}>
                  <span>{fill(p.tasksN, { n: x.tasks })}</span>
                  {x.needs > 0 ? <span className={s['count']}>{x.needs}</span> : null}
                  <span>{fill(p.appsN, { n: x.apps.length })}</span>
                </span>
                <span className={s['mono']}>{x.path}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One project (mockup frame 12): its tasks, its code, its apps, and a new task started here belongs to it. */
export function OneProject() {
  const model = useModel(identity);
  const now = useNow();
  const projectId = useUi((u) => u.projectId);
  const setScreen = useUi((u) => u.setScreen);
  const pr = copy.one.project;
  const project = projectId === null ? undefined : model.projects.byId[projectId];
  if (projectId === null || project === undefined || project.removedAt != null)
    return (
      <div className={s['page']} data-one-page="project">
        <p className={s['empty']}>{copy.one.projects.empty}</p>
      </div>
    );
  const tasks = oneTasks(model, now, projectId);
  const repo = repoOf(model, projectId);
  const apps = rows(model.targets).filter((t) => t.projectId === projectId);
  const lanes = tasks.filter((t) => t.state !== 'landed' && t.state !== 'finished').length;
  const ready = tasks.filter((t) => t.state === 'ready').length;
  return (
    <div className={s['page']} data-one-page="project">
      <div className={s['head']}>
        <h1 className={s['title']}>{project.name}</h1>
        <Button className={s['push']} onClick={() => setScreen('workspace')}>
          {pr.details}
        </Button>
      </div>
      <AskBox projectId={projectId} />
      <div className={s['grid2']}>
        <section className={s['box']} aria-label={pr.code}>
          <h2 className={s['h3']}>{pr.code}</h2>
          {repo === null ? (
            <p className={s['empty']}>{pr.noCode}</p>
          ) : (
            <dl className={s['kv']}>
              <dt>{pr.folder}</dt>
              <dd className={s['mono']}>{project.path}</dd>
              <dt>{pr.branch}</dt>
              <dd className={s['mono']}>{repo.defaultBranch ?? '—'}</dd>
              <dt>{pr.inProgress}</dt>
              <dd>{fill(pr.inProgressN, { n: lanes })}</dd>
              <dt>{pr.ready}</dt>
              <dd>{ready}</dd>
            </dl>
          )}
        </section>
        <section className={s['box']} aria-label={pr.apps}>
          <h2 className={s['h3']}>{pr.apps}</h2>
          {apps.length === 0 ? (
            <p className={s['empty']}>{pr.appsEmpty}</p>
          ) : (
            <ul className={s['apps']}>
              {apps.map((t) => (
                <li key={t.id} className={s['app']}>
                  {t.name} · {copy.one.apps.env[t.env]}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <h2 className={s['h3']}>{pr.tasks}</h2>
      {tasks.length === 0 ? <p className={s['empty']}>{copy.one.tasks.empty}</p> : <TaskList tasks={tasks} />}
    </div>
  );
}

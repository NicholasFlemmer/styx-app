import { copy, type ProjectId, type ReadModel, type SessionId, type TaskResult } from '@styx/core';
import { useModel } from '../../state/hooks';
import { useOpenTask } from './parts';
import s from './One.module.css';

const identity = (m: ReadModel) => m;

/** Results (mockup "Reports"): every campaign and report, newest first; each opens its task. */
export function OneResults() {
  const model = useModel(identity);
  const open = useOpenTask();
  const r = copy.one.results;
  const list = Object.values(model.taskResults)
    .filter((x) => model.sessions.byId[x.id] !== undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <div className={s['page']} data-one-page="results">
      <h1 className={s['title']}>{r.title}</h1>
      <p className={s['lead']}>{r.lead}</p>
      {list.length === 0 ? (
        <p className={s['empty']}>{r.empty}</p>
      ) : (
        <ul className={s['cards']}>
          {list.map((x) => (
            <li key={x.id}>
              <button
                type="button"
                className={s['card']}
                data-one-result-card={x.id}
                onClick={() => open(x.projectId as ProjectId, x.id as SessionId)}
              >
                <span className={s['facts']}>
                  <span>{model.projects.byId[x.projectId]?.name ?? ''}</span>
                  <span>{copy.one.kinds[x.body.kind]}</span>
                  {x.body.kind === 'report' && x.body.period !== undefined ? (
                    <span>{x.body.period}</span>
                  ) : null}
                </span>
                <span className={s['cardTitle']}>{x.body.title}</span>
                <span className={s['lead']}>{line(x)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One line under the title: the report's answer, or where the campaign stands. */
const line = (x: TaskResult): string => {
  if (x.body.kind === 'report') return x.body.headline;
  const r = copy.one.results;
  if (x.body.launch === undefined) return `${x.body.ads.length} ${r.ads.toLowerCase()}`;
  return x.launchApprovedAt === null ? r.awaiting : r.launched;
};

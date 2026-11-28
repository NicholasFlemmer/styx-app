import { copy, oneResults, type OneResult, type ProjectId, type ReadModel, type SessionId } from '@styx/core';
import { Button } from '@styx/ui';
import { useState } from 'react';
import { useModel, useNow } from '../../state/hooks';
import { useOpenTask } from './parts';
import s from './One.module.css';

const identity = (m: ReadModel) => m;
type Filter = 'all' | 'campaign' | 'report' | 'live' | 'needs';
const FILTERS: Filter[] = ['all', 'campaign', 'report', 'live', 'needs'];

const shows = (f: Filter, x: OneResult): boolean =>
  f === 'all'
    ? true
    : f === 'campaign' || f === 'report'
      ? x.kind === f
      : f === 'live'
        ? x.status === 'live' || x.status === 'launching'
        : x.status === 'waiting';

/**
 * Results (mockup styx-one-results.html, frame 7): every campaign and report, where each stands first, what needs
 * the person at the top. Each opens its task.
 */
export function OneResults() {
  const model = useModel(identity);
  const now = useNow();
  const open = useOpenTask();
  const [filter, setFilter] = useState<Filter>('all');
  const r = copy.one.results;
  const list = oneResults(model, now).filter((x) => shows(filter, x));
  return (
    <div className={s['page']} data-one-page="results">
      <div className={s['head']}>
        <h1 className={s['title']}>{r.title}</h1>
        <div className={`${s['filters']} ${s['push']}`} role="group" aria-label={r.title}>
          {FILTERS.map((f) => (
            <Button key={f} inv={filter === f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {r.filters[f]}
            </Button>
          ))}
        </div>
      </div>
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
                data-status={x.status}
                onClick={() => open(x.projectId as ProjectId, x.id as SessionId)}
              >
                <span className={s['facts']}>
                  <span className={s['statusPill']} data-status={x.status}>
                    {r.status[x.status]}
                  </span>
                  <span>{x.project}</span>
                  <span>{copy.one.kinds[x.kind]}</span>
                </span>
                <span className={s['cardTitle']}>{x.title}</span>
                <span className={s['lead']}>{x.line}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

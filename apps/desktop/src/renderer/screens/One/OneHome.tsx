import { copy, oneNeeds, oneRecord, oneTasks, type ReadModel } from '@styx/core';
import { Button } from '@styx/ui';
import { env } from '../../state/bridge';
import { useModel, useNow, useUi } from '../../state/hooks';
import { clockOffsetMinutes } from '../Approvals/approvals-data';
import { AskBox, NeedList, TaskList } from './parts';
import s from './One.module.css';

const identity = (m: ReadModel) => m;
const WEEK = 7 * 86_400_000;

const greetingAt = (now: number): string => {
  const h = new Date(now).getHours();
  return h < 12
    ? copy.one.greeting.morning
    : h < 18
      ? copy.one.greeting.afternoon
      : copy.one.greeting.evening;
};

/** Home (ADR-0033, mockup frame 1): the ask, every task in plain words, and on the right only what needs you. */
export function OneHome() {
  const model = useModel(identity);
  const now = useNow();
  const setScreen = useUi((u) => u.setScreen);
  const tasks = oneTasks(model, now);
  const needs = oneNeeds(model, now);
  const offset = clockOffsetMinutes(typeof env().now === 'number', now);
  const today = oneRecord(model, now, offset, true).slice(0, 8);
  const k = copy.one.kpi;
  const kpis: [string, number][] = [
    [k.working, tasks.filter((t) => t.state === 'working').length],
    [k.needs, needs.length],
    [k.ready, tasks.filter((t) => t.state === 'ready').length],
    [k.live, tasks.filter((t) => t.state === 'landed' && now - t.at < WEEK).length],
  ];
  return (
    <div className={s['split']} data-one-page="home">
      <div className={s['page']}>
        <h1 className={s['title']}>{greetingAt(now)}</h1>
        <AskBox />
        <div className={s['kpis']}>
          {kpis.map(([label, n]) => (
            <div key={label} className={s['kpi']}>
              {label}
              <b>{n}</b>
            </div>
          ))}
        </div>
        <div className={s['head']}>
          <h2 className={s['h3']}>{copy.one.tasks.title}</h2>
          <Button variant="ghost" className={s['push']} onClick={() => setScreen('one-tasks')}>
            {copy.one.seeAll}
          </Button>
        </div>
        {tasks.length === 0 ? (
          <p className={s['empty']}>{copy.one.tasks.empty}</p>
        ) : (
          <TaskList tasks={tasks.slice(0, 8)} />
        )}
      </div>
      <aside className={s['aside']} aria-label={copy.one.needs.title}>
        <h2 className={s['h3']}>{copy.one.needs.title}</h2>
        <NeedList needs={needs.slice(0, 5)} />
        <h2 className={s['h3']}>{copy.one.doneToday}</h2>
        {today.length === 0 ? (
          <p className={s['empty']}>{copy.one.nothingToday}</p>
        ) : (
          <ul className={s['lines']}>
            {today.map((l) => (
              <li key={l.id} className={s['line']}>
                <span className={s['lineText']}>{l.sentence}</span>
                <span className={s['lineTime']}>{l.time}</span>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}

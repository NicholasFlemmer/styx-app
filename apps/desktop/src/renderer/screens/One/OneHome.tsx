import { catalogueEntryFor, copy, oneNeeds, oneRecord, oneTasks, type ReadModel } from '@styx/core';
import { Button } from '@styx/ui';
import { env } from '../../state/bridge';
import { useModel, useNow, useUi } from '../../state/hooks';
import { clockOffsetMinutes } from '../Approvals/approvals-data';
import { useState } from 'react';
import { AskBox, NeedList, TaskList, type AskKind, type AskPreset } from './parts';
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
  const [preset, setPreset] = useState<AskPreset | null>(null);
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
        <AskBox preset={preset} />
        <Starters onPick={(kind, text) => setPreset({ kind, text, n: (preset?.n ?? 0) + 1 })} />
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

/** Ready-made tasks, from what is connected: none that needs an app this person has not connected. */
function Starters({ onPick }: { onPick: (kind: AskKind, text: string) => void }) {
  const apps = useModel((m) => m.connectedApps);
  const have = new Set(
    apps
      .filter((a) => a.status === 'connected')
      .map((a) => (a.kind === 'meta-ads' ? 'meta-ads' : (catalogueEntryFor(a.url)?.id ?? a.id))),
  );
  const st = copy.one.starters;
  const items = st.items.filter((x) => x.needs.every((n) => have.has(n)));
  return (
    <section aria-label={st.title}>
      <h2 className={s['h3']}>{st.title}</h2>
      <ul className={s['starters']}>
        {items.map((x) => (
          <li key={x.id}>
            <button
              type="button"
              className={s['starter']}
              data-one-starter={x.id}
              onClick={() => onPick(x.kind as AskKind, x.text)}
            >
              <b>{x.title}</b>
              <span className={s['needWhy']}>{x.blurb}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

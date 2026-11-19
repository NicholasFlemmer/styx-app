import { copy, oneTasks, type ReadModel } from '@styx/core';
import { Button } from '@styx/ui';
import { useState } from 'react';
import { useModel, useNow } from '../../state/hooks';
import { AskBox, TaskList } from './parts';
import s from './One.module.css';

const identity = (m: ReadModel) => m;
type Filter = 'all' | 'code' | 'design';
const FILTERS: Filter[] = ['all', 'code', 'design'];

/** Every task, whose move it is first; filtered by kind. */
export function OneTasks() {
  const model = useModel(identity);
  const now = useNow();
  const [filter, setFilter] = useState<Filter>('all');
  const t = copy.one.tasks;
  const tasks = oneTasks(model, now).filter((x) => filter === 'all' || x.kind === filter);
  return (
    <div className={s['page']} data-one-page="tasks">
      <h1 className={s['title']}>{t.title}</h1>
      <AskBox />
      <div className={s['filters']} role="group" aria-label={t.title}>
        {FILTERS.map((f) => (
          <Button key={f} inv={filter === f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {t[f]}
          </Button>
        ))}
      </div>
      {tasks.length === 0 ? <p className={s['empty']}>{t.empty}</p> : <TaskList tasks={tasks} />}
    </div>
  );
}

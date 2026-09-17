import { copy } from '@styx/core';
import s from './Usage.module.css';

/** Usage across providers (owner request after t3code): placeholder until the usage work package lands. */
export function Usage() {
  return (
    <div className={s['screen']} data-usage="true">
      <header className={s['header']}>
        <h2 className={s['title']}>{copy.usage.title}</h2>
      </header>
    </div>
  );
}

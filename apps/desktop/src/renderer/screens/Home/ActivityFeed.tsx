import { copy, type HomeActivityRow } from '@styx/core';
import { Label } from '@styx/ui';
import s from './Home.module.css';

export interface ActivityFeedProps {
  rows: readonly HomeActivityRow[];
}

/** "Activity" label + mono feed, newest first (spec §4.2). Time 44 · who 110 (--tx) · what, gap 16. */
export function ActivityFeed({ rows }: ActivityFeedProps) {
  return (
    <>
      <Label as="div" className={s['activityHead']} id="home-activity-label">
        {copy.home.activity}
      </Label>
      <ul className={s['feed']} aria-labelledby="home-activity-label" data-activity-feed="true">
        {rows.map((a) => (
          <li key={a.id} className={s['feedRow']}>
            <span className={s['feedTime']}>{a.t}</span>
            <span className={s['feedWho']}>{a.who}</span>
            <span className={s['feedWhat']}>{a.what}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

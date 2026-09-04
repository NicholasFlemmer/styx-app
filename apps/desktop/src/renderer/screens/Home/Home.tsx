import { copy } from '@styx/core';
import s from '../../app/Shell.module.css';

/** Placeholder until the Home screen is ported; the outlet marks `data-screen-ready` once mounted. */
export function Home() {
  return (
    <div className={s['placeholder']} data-screen-placeholder="Home">
      <span className="t-label">{copy.nav.home}</span>
    </div>
  );
}

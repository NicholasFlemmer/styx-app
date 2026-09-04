import { copy } from '@styx/core';
import s from '../../app/Shell.module.css';

/** Placeholder until the Repo screen is ported; the outlet marks `data-screen-ready` once mounted. */
export function Repo() {
  return (
    <div className={s['placeholder']} data-screen-placeholder="Repo">
      <span className="t-label">{copy.nav.repo}</span>
    </div>
  );
}

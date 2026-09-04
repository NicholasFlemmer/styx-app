import { copy } from '@styx/core';
import s from '../../app/Shell.module.css';

/** Placeholder until the Settings screen is ported; the outlet marks `data-screen-ready` once mounted. */
export function Settings() {
  return (
    <div className={s['placeholder']} data-screen-placeholder="Settings">
      <span className="t-label">{copy.nav.settings}</span>
    </div>
  );
}

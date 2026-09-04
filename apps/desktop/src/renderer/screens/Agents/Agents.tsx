import { copy } from '@styx/core';
import s from '../../app/Shell.module.css';

/** Placeholder until the Agents screen is ported; the outlet marks `data-screen-ready` once mounted. */
export function Agents() {
  return (
    <div className={s['placeholder']} data-screen-placeholder="Agents">
      <span className="t-label">{copy.nav.agents}</span>
    </div>
  );
}

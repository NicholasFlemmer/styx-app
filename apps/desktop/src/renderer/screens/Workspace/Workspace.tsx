import { copy } from '@styx/core';
import s from '../../app/Shell.module.css';

/** Placeholder until the Workspace screen is ported; the outlet marks `data-screen-ready` once mounted. */
export function Workspace() {
  return (
    <div className={s['placeholder']} data-screen-placeholder="Workspace">
      <span className="t-label">{copy.nav.workspace}</span>
    </div>
  );
}

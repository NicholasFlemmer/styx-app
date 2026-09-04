import { copy } from '@styx/core';
import s from '../../app/Shell.module.css';

/** Placeholder until the Approvals screen is ported; the outlet marks `data-screen-ready` once mounted. */
export function Approvals() {
  return (
    <div className={s['placeholder']} data-screen-placeholder="Approvals">
      <span className="t-label">{copy.nav.approvals}</span>
    </div>
  );
}

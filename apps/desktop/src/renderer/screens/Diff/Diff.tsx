import { copy } from '@styx/core';
import s from '../../app/Shell.module.css';

/** Placeholder until the Diff screen is ported; the outlet marks `data-screen-ready` once mounted. */
export function Diff() {
  return (
    <div className={s['placeholder']} data-screen-placeholder="Diff">
      <span className="t-label">{copy.diff.title}</span>
    </div>
  );
}

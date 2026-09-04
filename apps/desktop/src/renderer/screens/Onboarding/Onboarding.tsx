import { copy } from '@styx/core';
import s from '../../app/Shell.module.css';

/** Placeholder until the Onboarding screen is ported; the outlet marks `data-screen-ready` once mounted. */
export function Onboarding() {
  return (
    <div className={s['placeholder']} data-screen-placeholder="Onboarding">
      <span className="t-label">{copy.onboarding.editor.headline}</span>
    </div>
  );
}

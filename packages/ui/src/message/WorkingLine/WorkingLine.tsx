import { forwardRef, type HTMLAttributes } from 'react';
import { StatusDot } from '../../primitives';
import s from './WorkingLine.module.css';

export interface WorkingLineProps extends HTMLAttributes<HTMLDivElement> {
  /** "Thinking…" / "Working…" / "Running Bash…" (app: `copy.chat.working.*`). */
  label: string;
  /** "12s" in tabular numerals after the label (app: `copy.chat.working.elapsed`). */
  elapsedLabel?: string;
  /** Pop-out chat: 12px type stays; the row only tightens its padding. */
  compact?: boolean;
}

/**
 * Live working line at the bottom of a transcript while the session works and nothing is streaming (owner
 * addition, discrepancy #55): a blinking 7px accent square, the t-label, the elapsed seconds. `role=status`
 * with `aria-live=off`: the transcript log is already polite and the seconds must not be announced every tick.
 */
export const WorkingLine = forwardRef<HTMLDivElement, WorkingLineProps>(function WorkingLine(
  { label, elapsedLabel, compact, className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      role="status"
      aria-live="off"
      data-working-line="true"
      className={[s['line'], compact ? s['compact'] : undefined, className].filter(Boolean).join(' ')}
      {...rest}
    >
      <StatusDot tone="accent" size={7} className={s['dot']} />
      <span className={s['label']}>{label}</span>
      {elapsedLabel !== undefined && <span className={s['elapsed']}>{elapsedLabel}</span>}
    </div>
  );
});

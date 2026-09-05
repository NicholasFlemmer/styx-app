import { forwardRef, type HTMLAttributes } from 'react';
import { formatNumeral } from '../../primitives/Numeral';
import { StatusDot, type DotTone } from '../../primitives/StatusDot';
import s from './TitlebarCounter.module.css';

export interface TitlebarCounterProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  count: number;
  /** Uppercased via CSS: "needs you", "locked". */
  label: string;
  /** accent for needs-you, hollowStrong for locked. */
  tone?: DotTone;
  /** aria-live=polite (needs-you). */
  live?: boolean;
  pad?: number;
  inv?: boolean;
  on?: boolean;
}

/** t-label + 8px StatusDot: "02 NEEDS YOU" / "01 LOCKED". */
export const TitlebarCounter = forwardRef<HTMLSpanElement, TitlebarCounterProps>(function TitlebarCounter(
  { count, label, tone = 'accent', live, pad = 2, inv, on, className, ...rest },
  ref,
) {
  const cls = [s['counter'], className].filter(Boolean).join(' ');
  return (
    <span
      ref={ref}
      className={cls}
      aria-live={live ? 'polite' : undefined}
      aria-atomic={live ? true : undefined}
      data-inv={inv ? 'true' : undefined}
      data-on={on ? 'true' : undefined}
      {...rest}
    >
      <StatusDot tone={tone} size={8} />
      {/* Prototype: the numeral is its own flex item, so the 6px gap (not a space) separates it from the label. */}
      <span className={s['text']}>{formatNumeral(count, pad)}</span>
      <span className={s['srSpace']}> </span>
      <span className={s['text']}>{label}</span>
    </span>
  );
});

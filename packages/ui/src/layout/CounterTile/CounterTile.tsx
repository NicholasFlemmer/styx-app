import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { Numeral } from '../../primitives/Numeral';
import s from './CounterTile.module.css';

export interface CounterTileProps extends HTMLAttributes<HTMLDivElement> {
  value: number;
  label: ReactNode;
  /** aria-live=polite (needs-you counters). */
  live?: boolean;
  pad?: number;
  inv?: boolean;
  on?: boolean;
  /** Attention (ADR-0027 §6): the number turns accent-as-text and the tile stays quiet. */
  attention?: boolean;
}

/** Home counter: Numeral L + t-label, `22px 20px 18px`, hairline right. */
export const CounterTile = forwardRef<HTMLDivElement, CounterTileProps>(function CounterTile(
  { value, label, live, pad = 2, inv, on, attention, className, ...rest },
  ref,
) {
  const cls = [s['tile'], className].filter(Boolean).join(' ');
  return (
    <div
      ref={ref}
      className={cls}
      aria-live={live ? 'polite' : undefined}
      aria-atomic={live ? true : undefined}
      data-inv={inv ? 'true' : undefined}
      data-on={on ? 'true' : undefined}
      data-attention={attention ? 'true' : undefined}
      {...rest}
    >
      <Numeral size="L" value={value} pad={pad} className={s['numeral']} />
      <div className={s['label']} data-muted="true">
        {label}
      </div>
    </div>
  );
});

export interface CounterStripProps extends HTMLAttributes<HTMLDivElement> {
  /** Number of equal columns (Home has 4). */
  columns?: number;
  inv?: boolean;
  on?: boolean;
  children?: ReactNode;
}

export const CounterStrip = forwardRef<HTMLDivElement, CounterStripProps>(function CounterStrip(
  { columns = 4, inv, on, className, style, ...rest },
  ref,
) {
  const cls = [s['strip'], className].filter(Boolean).join(' ');
  return (
    <div
      ref={ref}
      className={cls}
      style={{ ...style, gridTemplateColumns: `repeat(${columns}, 1fr)` }}
      data-inv={inv ? 'true' : undefined}
      data-on={on ? 'true' : undefined}
      {...rest}
    />
  );
});

import { forwardRef, type HTMLAttributes } from 'react';
import s from './Numeral.module.css';

export type NumeralSize = 'M' | 'L';

export interface NumeralProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  value: number;
  /** M = 28px (-.02em); L = 56px (-.03em). */
  size?: NumeralSize;
  /** Zero-pad width (counters are always zero-padded). */
  pad?: number;
  inv?: boolean;
  on?: boolean;
}

export function formatNumeral(value: number, pad = 2): string {
  const neg = value < 0;
  const digits = String(Math.abs(Math.trunc(value))).padStart(pad, '0');
  return neg ? `-${digits}` : digits;
}

export const Numeral = forwardRef<HTMLSpanElement, NumeralProps>(function Numeral(
  { value, size = 'M', pad = 2, inv, on, className, ...rest },
  ref,
) {
  const cls = [s['numeral'], size === 'L' ? s['l'] : s['m'], className].filter(Boolean).join(' ');
  return (
    <span
      ref={ref}
      className={cls}
      data-inv={inv ? 'true' : undefined}
      data-on={on ? 'true' : undefined}
      {...rest}
    >
      {formatNumeral(value, pad)}
    </span>
  );
});

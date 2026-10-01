import type { ButtonHTMLAttributes } from 'react';
import s from './Receipt.module.css';

export interface ReceiptProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** What the turn was for: the first line of what the person asked. */
  title: string;
  /** "Kept 09:12" / "Undone 09:31" / "Answered 10:02". */
  meta: string;
  state: 'kept' | 'undone' | 'answered';
}

/**
 * A finished turn folded to one line (ADR-0027 §3), so a session that has run all day still reads at a glance.
 * A button: opening it shows the turn again.
 */
export function Receipt({ title, meta, state, className, type = 'button', ...rest }: ReceiptProps) {
  return (
    <button
      type={type}
      className={[s['receipt'], className].filter(Boolean).join(' ')}
      aria-expanded="false"
      data-kind="receipt"
      data-state={state}
      {...rest}
    >
      <span className={s['title']}>{title}</span>
      <span className={s['meta']}>{meta}</span>
    </button>
  );
}

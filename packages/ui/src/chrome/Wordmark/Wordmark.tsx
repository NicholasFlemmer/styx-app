import { forwardRef, type HTMLAttributes } from 'react';
import s from './Wordmark.module.css';

export interface WordmarkProps extends HTMLAttributes<HTMLSpanElement> {
  inv?: boolean;
  on?: boolean;
}

/** STYX · 700 13px .12em. */
export const Wordmark = forwardRef<HTMLSpanElement, WordmarkProps>(function Wordmark(
  { inv, on, className, children = 'STYX', ...rest },
  ref,
) {
  const cls = [s['wordmark'], className].filter(Boolean).join(' ');
  return (
    <span ref={ref} className={cls} data-inv={inv ? 'true' : undefined} data-on={on ? 'true' : undefined} {...rest}>
      {children}
    </span>
  );
});

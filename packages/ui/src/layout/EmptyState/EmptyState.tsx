import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import s from './EmptyState.module.css';

export interface EmptyStateProps extends HTMLAttributes<HTMLDivElement> {
  headline: ReactNode;
  body?: ReactNode;
  /** Compact buttons, gap 6. */
  actions?: ReactNode;
  inv?: boolean;
  on?: boolean;
}

export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
  { headline, body, actions, inv, on, className, ...rest },
  ref,
) {
  const cls = [s['empty'], className].filter(Boolean).join(' ');
  return (
    <div ref={ref} className={cls} data-inv={inv ? 'true' : undefined} data-on={on ? 'true' : undefined} {...rest}>
      <div className={s['headline']}>{headline}</div>
      {body !== undefined && body !== null ? <div className={s['body']} data-muted="true">{body}</div> : null}
      {actions !== undefined && actions !== null ? <div className={s['actions']}>{actions}</div> : null}
    </div>
  );
});

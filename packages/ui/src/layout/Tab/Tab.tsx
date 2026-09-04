import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { Icon } from '../../primitives/Icon';
import { StatusDot, type DotTone } from '../../primitives/StatusDot';
import s from './Tab.module.css';

/** session = chat pane agent tabs (34px, 600 12px) · file = editor file tabs (mono 400 12px) · approvals = section tabs (700 10px uppercase). */
export type TabVariant = 'session' | 'file' | 'approvals';

export interface TabProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  label: ReactNode;
  variant?: TabVariant;
  /** 7px status dot before the label. */
  dot?: DotTone;
  /** Accent `!` badge (needs you). */
  badge?: boolean;
  /** Trailing node after the label (e.g. an agent Tag on a file tab). */
  meta?: ReactNode;
  /** JetBrains Mono label (file tabs). */
  mono?: boolean;
  /** Overflow tab: renders a ▾ chevron. */
  overflow?: boolean;
  /** Current tab. */
  inv?: boolean;
  on?: boolean;
}

export const Tab = forwardRef<HTMLButtonElement, TabProps>(function Tab(
  { label, variant = 'session', dot, badge, meta, mono, overflow, inv, on, className, type = 'button', ...rest },
  ref,
) {
  const isFile = variant === 'file';
  const cls = [s['tab'], s[variant], (mono ?? isFile) && s['mono'], className].filter(Boolean).join(' ');
  return (
    <button
      ref={ref}
      type={type}
      role="tab"
      aria-selected={inv ? true : false}
      className={cls}
      data-inv={inv ? 'true' : undefined}
      data-on={on ? 'true' : undefined}
      {...rest}
    >
      {dot ? <StatusDot tone={dot} size={7} /> : null}
      <span className={s['label']}>{label}</span>
      {badge ? (
        <span className={s['badge']} aria-label="needs you" role="img">
          !
        </span>
      ) : null}
      {meta !== undefined && meta !== null ? <span className={s['meta']}>{meta}</span> : null}
      {overflow ? <Icon name="chevron" className={s['chevron']} /> : null}
    </button>
  );
});

export interface TabRowProps extends HTMLAttributes<HTMLDivElement> {
  /** approvals rows are taller than 34px (padding-driven). */
  variant?: TabVariant;
  inv?: boolean;
  on?: boolean;
  children?: ReactNode;
}

export const TabRow = forwardRef<HTMLDivElement, TabRowProps>(function TabRow(
  { variant = 'session', inv, on, className, ...rest },
  ref,
) {
  const cls = [s['row'], variant === 'approvals' ? s['rowAuto'] : s['rowFixed'], variant === 'file' && s['rowMono'], className]
    .filter(Boolean)
    .join(' ');
  return (
    <div ref={ref} role="tablist" className={cls} data-inv={inv ? 'true' : undefined} data-on={on ? 'true' : undefined} {...rest} />
  );
});

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import s from './NavItem.module.css';

export interface NavItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  label: ReactNode;
  /** Mono 11px trailing meta (counts, ages). */
  meta?: ReactNode;
  /** Settings nav: `7px 16px`, no divider. */
  dense?: boolean;
  /** Current item. */
  inv?: boolean;
  on?: boolean;
}

export const NavItem = forwardRef<HTMLButtonElement, NavItemProps>(function NavItem(
  { label, meta, dense, inv, on, className, type = 'button', ...rest },
  ref,
) {
  const cls = [s['item'], dense && s['dense'], className].filter(Boolean).join(' ');
  return (
    <button
      ref={ref}
      type={type}
      className={cls}
      aria-current={inv ? 'page' : undefined}
      data-inv={inv ? 'true' : undefined}
      data-on={on ? 'true' : undefined}
      {...rest}
    >
      <span className={s['label']}>{label}</span>
      {meta !== undefined && meta !== null ? <span className={s['meta']}>{meta}</span> : null}
    </button>
  );
});

import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Icon, type IconName } from '../../primitives/Icon';
import s from './RailTile.module.css';

export type RailTileVariant = 'project' | 'add';

export interface RailTileProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'title'> {
  /** Two-letter initials (project tiles). */
  initials?: string;
  /** A navigation icon instead of initials (app rail tiles). */
  icon?: IconName;
  /** Tooltip and accessible name. */
  title: string;
  /** Current project → data-on. */
  active?: boolean;
  /** What `active` means for AT: a current item (project tiles) or the current page (app rail navigation tiles). */
  current?: 'true' | 'page';
  /** Needs-you corner square. */
  needs?: boolean;
  /** What the corner stands for, in the accessible name ("2 in the inbox"); defaults to "needs you". */
  needsLabel?: string;
  /** add = dashed `+` tile. */
  variant?: RailTileVariant;
  inv?: boolean;
  on?: boolean;
}

export const RailTile = forwardRef<HTMLButtonElement, RailTileProps>(function RailTile(
  {
    initials,
    icon,
    title,
    active,
    current = 'true',
    needs,
    needsLabel = 'needs you',
    variant = 'project',
    inv,
    on,
    className,
    type = 'button',
    ...rest
  },
  ref,
) {
  const isAdd = variant === 'add';
  const cls = [s['tile'], isAdd ? s['add'] : s['project'], className].filter(Boolean).join(' ');
  const name = needs ? `${title} · ${needsLabel}` : title;
  return (
    <button
      ref={ref}
      type={type}
      className={cls}
      title={title}
      aria-label={name}
      aria-current={active ? current : undefined}
      data-inv={inv ? 'true' : undefined}
      data-on={on || active ? 'true' : undefined}
      {...rest}
    >
      {isAdd ? '+' : icon !== undefined ? <Icon name={icon} size={16} /> : initials}
      {needs ? <span className={s['corner']} aria-hidden="true" /> : null}
    </button>
  );
});

import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import s from './Titlebar.module.css';

export type TitlebarPlatform = 'darwin' | 'win32';

export interface TitlebarProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  /** darwin reserves 70px for traffic lights; win32 reserves 138px for the overlay controls. */
  platform?: TitlebarPlatform;
  /** Wordmark, project switcher, branch. */
  left?: ReactNode;
  /** Flexible middle region. */
  center?: ReactNode;
  /** Palette field, counters. */
  right?: ReactNode;
  inv?: boolean;
  on?: boolean;
}

/** Class for interactive children that must not drag the window (buttons/inputs/selects inside get it automatically). */
export const noDrag: string = s['noDrag'] ?? 'noDrag';

export const Titlebar = forwardRef<HTMLElement, TitlebarProps>(function Titlebar(
  { platform = 'darwin', left, center, right, inv, on, className, ...rest },
  ref,
) {
  const cls = [s['titlebar'], platform === 'darwin' ? s['mac'] : s['win'], className].filter(Boolean).join(' ');
  return (
    <header
      ref={ref}
      className={cls}
      data-platform={platform}
      data-inv={inv ? 'true' : undefined}
      data-on={on ? 'true' : undefined}
      {...rest}
    >
      {left !== undefined && left !== null ? <div className={s['slot']}>{left}</div> : null}
      <div className={[s['slot'], s['center']].join(' ')}>{center}</div>
      {right !== undefined && right !== null ? <div className={s['slot']}>{right}</div> : null}
    </header>
  );
});

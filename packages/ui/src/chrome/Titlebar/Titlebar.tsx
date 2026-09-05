import { createElement, forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import s from './Titlebar.module.css';

export type TitlebarPlatform = 'darwin' | 'win32';

export interface TitlebarProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  /** darwin: content starts at 80px (traffic lights + gap); win32: content ends 150px before the edge (caption strip + gap). */
  platform?: TitlebarPlatform;
  /** Wordmark, project switcher, branch. */
  left?: ReactNode;
  /** Flexible middle region. */
  center?: ReactNode;
  /** Palette field, counters. */
  right?: ReactNode;
  inv?: boolean;
  on?: boolean;
  /**
   * Render as the page-level `<header>` (banner landmark). Pass false when several titlebars share a document
   * (matrices, previews) so there is a single banner; the bar then renders as a plain `<div>`.
   */
  asLandmark?: boolean;
}

/** Class for interactive children that must not drag the window (buttons/inputs/selects inside get it automatically). */
export const noDrag: string = s['noDrag'] ?? 'noDrag';

export const Titlebar = forwardRef<HTMLElement, TitlebarProps>(function Titlebar(
  { platform = 'darwin', left, center, right, inv, on, asLandmark = true, className, ...rest },
  ref,
) {
  const cls = [s['titlebar'], platform === 'darwin' ? s['mac'] : s['win'], className].filter(Boolean).join(' ');
  // createElement (not a `Tag` variable) so the forwarded HTMLElement ref types for both `header` and `div`.
  return createElement(
    asLandmark ? 'header' : 'div',
    {
      ref,
      className: cls,
      'data-platform': platform,
      'data-inv': inv ? 'true' : undefined,
      'data-on': on ? 'true' : undefined,
      ...rest,
    },
    left !== undefined && left !== null ? <div className={s['slot']}>{left}</div> : null,
    <div className={[s['slot'], s['center']].join(' ')}>{center}</div>,
    right !== undefined && right !== null ? <div className={s['slot']}>{right}</div> : null,
  );
});

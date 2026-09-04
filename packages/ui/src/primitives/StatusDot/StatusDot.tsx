import { forwardRef, type HTMLAttributes } from 'react';
import s from './StatusDot.module.css';

/** accent = needs you · text = working · line = idle/done · hollow = --ln outline · hollowStrong = --tx outline (locked). */
export type DotTone = 'accent' | 'text' | 'line' | 'hollow' | 'hollowStrong';
export type DotSize = 8 | 7;

export interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: DotTone;
  /** 8 in titlebar/tables/banners; 7 in tabs and lanes. */
  size?: DotSize;
  /** Accessible name; without it the dot is decorative (aria-hidden). */
  label?: string;
  inv?: boolean;
  on?: boolean;
}

export const StatusDot = forwardRef<HTMLSpanElement, StatusDotProps>(function StatusDot(
  { tone = 'accent', size = 8, label, inv, on, className, ...rest },
  ref,
) {
  const cls = [s['dot'], s[tone], size === 7 ? s['s7'] : s['s8'], className].filter(Boolean).join(' ');
  return (
    <span
      ref={ref}
      className={cls}
      data-tone={tone}
      data-inv={inv ? 'true' : undefined}
      data-on={on ? 'true' : undefined}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      {...rest}
    />
  );
});

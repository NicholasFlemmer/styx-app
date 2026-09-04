import { forwardRef, type HTMLAttributes } from 'react';
import s from './Tag.module.css';

export type TagTone = 'neutral' | 'accent' | 'agent' | 'strong';
export type TagSize = 'sm' | 'md';

export interface TagProps extends HTMLAttributes<HTMLSpanElement> {
  /** neutral = hairline; accent = PROD (data-on); agent = CLAUDE badge (600, 1px 4px); strong = --tx border. */
  tone?: TagTone;
  /** sm = 9px `1px 5px` (tables, approvals); md = 10px `2px 6px` (sheet header). */
  size?: TagSize;
  inv?: boolean;
  on?: boolean;
}

export const Tag = forwardRef<HTMLSpanElement, TagProps>(function Tag(
  { tone = 'neutral', size = 'sm', inv, on, className, ...rest },
  ref,
) {
  const accent = on || tone === 'accent';
  const cls = [s['tag'], s[tone], s[size], className].filter(Boolean).join(' ');
  return (
    <span
      ref={ref}
      className={cls}
      data-tone={tone}
      data-inv={inv ? 'true' : undefined}
      data-on={accent ? 'true' : undefined}
      {...rest}
    />
  );
});

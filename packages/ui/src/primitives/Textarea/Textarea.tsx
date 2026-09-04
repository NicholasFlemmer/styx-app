import { forwardRef, type TextareaHTMLAttributes } from 'react';
import s from './Textarea.module.css';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** JetBrains Mono 12.5px. */
  mono?: boolean;
  /** Minimum height in px (brief field is 64). */
  minHeight?: number;
  inv?: boolean;
  on?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { mono, minHeight = 64, inv, on, className, style, ...rest },
  ref,
) {
  const cls = [s['textarea'], mono && s['mono'], className].filter(Boolean).join(' ');
  return (
    <textarea
      ref={ref}
      className={cls}
      style={{ ...style, minHeight }}
      data-inv={inv ? 'true' : undefined}
      data-on={on ? 'true' : undefined}
      {...rest}
    />
  );
});

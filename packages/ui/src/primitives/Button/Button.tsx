import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import s from './Button.module.css';

export type ButtonVariant = 'secondary' | 'primary' | 'accent' | 'ghost' | 'dashed';
export type ButtonSize = 'compact' | 'regular' | 'hunk' | 'footer';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** secondary = hairline; primary = --tx fill; accent = Grant only; ghost = muted; dashed = add actions. */
  variant?: ButtonVariant;
  /** compact 5×10 · regular 6×12 · hunk 4×10 · footer 14px full-width row (44px tall). */
  size?: ButtonSize;
  /** Inverted (current) state, e.g. the chosen Accept/Reject in diff review. */
  inv?: boolean;
  /** Accent (armed) state. */
  on?: boolean;
  /** flex-grow inside footer rows (Grant is 1.4, Deny 1). */
  grow?: number;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'compact', inv, on, grow, className, type = 'button', style, ...rest },
  ref,
) {
  const cls = [s['button'], s[variant], s[size], className].filter(Boolean).join(' ');
  return (
    <button
      ref={ref}
      type={type}
      className={cls}
      data-inv={inv ? 'true' : undefined}
      data-on={on ? 'true' : undefined}
      style={grow !== undefined ? { ...style, flex: grow } : style}
      {...rest}
    />
  );
});

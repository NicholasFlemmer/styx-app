import { forwardRef, type ButtonHTMLAttributes } from 'react';
import s from './TitlebarField.module.css';

export type TitlebarFieldPlatform = 'darwin' | 'win32';

export interface TitlebarFieldProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Muted prompt text. */
  placeholder?: string;
  /** Picks the shortcut hint: ⌘K on darwin, Ctrl K on win32. */
  platform?: TitlebarFieldPlatform;
  /** Override the hint text. */
  hint?: string;
  inv?: boolean;
  on?: boolean;
}

/** The palette field in the titlebar: a 280px hairline button with a ⌘K hint. */
export const TitlebarField = forwardRef<HTMLButtonElement, TitlebarFieldProps>(function TitlebarField(
  {
    placeholder = 'Switch, spawn, deploy, grant…',
    platform = 'darwin',
    hint,
    inv,
    on,
    className,
    type = 'button',
    'aria-label': ariaLabel = 'Open command palette',
    ...rest
  },
  ref,
) {
  const cls = [s['field'], className].filter(Boolean).join(' ');
  const hintText = hint ?? (platform === 'darwin' ? '⌘K' : 'Ctrl K');
  return (
    <button
      ref={ref}
      type={type}
      className={cls}
      aria-label={ariaLabel}
      aria-keyshortcuts={platform === 'darwin' ? 'Meta+K' : 'Control+K'}
      data-inv={inv ? 'true' : undefined}
      data-on={on ? 'true' : undefined}
      {...rest}
    >
      <span className={s['placeholder']}>{placeholder}</span>
      <span className={s['hint']} aria-hidden="true">
        {hintText}
      </span>
    </button>
  );
});

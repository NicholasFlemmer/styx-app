import { forwardRef, type ButtonHTMLAttributes } from 'react';
import s from './TitlebarField.module.css';

export type TitlebarFieldPlatform = 'darwin' | 'win32';

export interface TitlebarFieldProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Muted prompt text. */
  placeholder?: string;
  /** Keyboard platform for `aria-keyshortcuts` (Meta+K on darwin, Control+K on win32). */
  platform?: TitlebarFieldPlatform;
  /** Shortcut hint text, formatted by the app (`formatChord(shortcuts.palette, platform)`: ⌘K / Ctrl+K). */
  hint: string;
  inv?: boolean;
  on?: boolean;
}

/** The palette field in the titlebar: a 280px hairline button with the palette chord as its hint. */
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
        {hint}
      </span>
    </button>
  );
});

import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import s from './Checkbox.module.css';

export type CheckboxSize = 14 | 16;
/** inverted = checked fills --tx (grant scope, onboarding); accent = checked → data-on (policy toggles). */
export type CheckboxTone = 'inverted' | 'accent';

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'type' | 'onChange' | 'checked'> {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  size?: CheckboxSize;
  tone?: CheckboxTone;
  /** Row text; the whole row is the hit target. */
  label?: ReactNode;
  /** Put the label before the box (grant-sheet scope rows: text left, box right). */
  labelSide?: 'start' | 'end';
  inv?: boolean;
  on?: boolean;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { checked, onChange, size = 14, tone = 'inverted', label, labelSide = 'end', inv, on, className, id, disabled, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const armed = tone === 'accent' && checked;
  const filled = tone === 'inverted' && checked;
  const rowCls = [
    s['row'],
    labelSide === 'start' && s['labelStart'],
    disabled && s['disabled'],
    className,
  ]
    .filter(Boolean)
    .join(' ');
  const boxCls = [s['box'], size === 16 ? s['s16'] : s['s14'], filled && s['filled']].filter(Boolean).join(' ');
  return (
    <label
      className={rowCls}
      htmlFor={inputId}
      data-inv={inv ? 'true' : undefined}
      data-on={on ? 'true' : undefined}
    >
      <input
        ref={ref}
        id={inputId}
        type="checkbox"
        className={s['input']}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange?.(e.currentTarget.checked)}
        {...rest}
      />
      <span className={boxCls} data-on={armed ? 'true' : undefined} aria-hidden="true" />
      {label !== undefined && label !== null ? <span className={s['label']}>{label}</span> : null}
    </label>
  );
});

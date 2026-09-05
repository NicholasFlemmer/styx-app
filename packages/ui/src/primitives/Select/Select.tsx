import { forwardRef, useRef, type CSSProperties, type MouseEvent, type ReactNode, type SelectHTMLAttributes } from 'react';
import { Icon } from '../Icon';
import s from './Select.module.css';

export interface SelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'style' | 'className'> {
  options?: SelectOption[];
  /** Fixed width (170 in the Targets table); defaults to `min-width:140px`. */
  width?: number | string;
  /** Applied to the wrapper. */
  className?: string;
  style?: CSSProperties;
  inv?: boolean;
  on?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, width, className, style, inv, on, children, disabled, ...rest },
  ref,
) {
  const cls = [s['wrap'], disabled && s['disabled'], className].filter(Boolean).join(' ');
  const inner = useRef<HTMLSelectElement | null>(null);
  const setRef = (el: HTMLSelectElement | null) => {
    inner.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref !== null) ref.current = el;
  };
  /** Clicks on the wrapper's 2px bleed (outside the 25px box) still open the select (spec §9 hit targets). */
  const onWrapClick = (e: MouseEvent<HTMLSpanElement>) => {
    if (e.target !== e.currentTarget || disabled) return;
    const el = inner.current;
    if (el === null) return;
    el.focus();
    try {
      (el as HTMLSelectElement & { showPicker?: () => void }).showPicker?.();
    } catch {
      /* needs a user gesture; focus is enough */
    }
  };
  return (
    <span
      className={cls}
      style={width !== undefined ? { ...style, width } : style}
      data-inv={inv ? 'true' : undefined}
      data-on={on ? 'true' : undefined}
      onClick={onWrapClick}
    >
      <select ref={setRef} className={s['select']} disabled={disabled} {...rest}>
        {options?.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
        {children}
      </select>
      <Icon name="chevron" className={s['chevron']} />
    </span>
  );
});

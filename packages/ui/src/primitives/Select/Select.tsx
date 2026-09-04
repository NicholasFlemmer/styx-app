import { forwardRef, type CSSProperties, type ReactNode, type SelectHTMLAttributes } from 'react';
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
  return (
    <span
      className={cls}
      style={width !== undefined ? { ...style, width } : style}
      data-inv={inv ? 'true' : undefined}
      data-on={on ? 'true' : undefined}
    >
      <select ref={ref} className={s['select']} disabled={disabled} {...rest}>
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

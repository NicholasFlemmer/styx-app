import { forwardRef, type CSSProperties, type InputHTMLAttributes, type ReactNode } from 'react';
import s from './Input.module.css';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'style' | 'className'> {
  /** JetBrains Mono 12.5px (paths, hosts, secrets). */
  mono?: boolean;
  /** Secret entry: type=password, mono. */
  masked?: boolean;
  /** Trailing node inside the border, e.g. a Browse button. */
  trailing?: ReactNode;
  /** Applied to the bordered wrapper. */
  className?: string;
  style?: CSSProperties;
  inv?: boolean;
  on?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { mono, masked, trailing, className, style, inv, on, type, disabled, ...rest },
  ref,
) {
  const isMono = mono || masked;
  const cls = [s['field'], isMono && s['mono'], disabled && s['disabled'], className].filter(Boolean).join(' ');
  return (
    <div className={cls} style={style} data-inv={inv ? 'true' : undefined} data-on={on ? 'true' : undefined}>
      <input
        ref={ref}
        className={s['input']}
        type={masked ? 'password' : (type ?? 'text')}
        disabled={disabled}
        {...rest}
      />
      {trailing !== undefined && trailing !== null ? <span className={s['trailing']}>{trailing}</span> : null}
    </div>
  );
});

import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { Label } from '../Label';
import s from './Field.module.css';

export interface FieldProps extends HTMLAttributes<HTMLDivElement> {
  /** Label text rendered above the control (t-label). */
  label: ReactNode;
  /** id of the control the label points at. */
  htmlFor?: string;
  /** Helper text under the control (11.5px --mu). */
  hint?: ReactNode;
  inv?: boolean;
  on?: boolean;
  children?: ReactNode;
}

export const Field = forwardRef<HTMLDivElement, FieldProps>(function Field(
  { label, htmlFor, hint, inv, on, className, children, ...rest },
  ref,
) {
  const cls = [s['field'], className].filter(Boolean).join(' ');
  return (
    <div ref={ref} className={cls} data-inv={inv ? 'true' : undefined} data-on={on ? 'true' : undefined} {...rest}>
      {htmlFor ? (
        <Label as="label" htmlFor={htmlFor}>{label}</Label>
      ) : (
        <Label as="span">{label}</Label>
      )}
      {children}
      {hint !== undefined && hint !== null ? <div className={s['hint']}>{hint}</div> : null}
    </div>
  );
});

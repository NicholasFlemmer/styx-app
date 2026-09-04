import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { Button } from '../../primitives/Button';
import s from './LabelValueRow.module.css';

export interface LabelValueRowProps extends HTMLAttributes<HTMLDivElement> {
  label: ReactNode;
  /** Right-hand control (Select, Checkbox, Tag …). */
  control?: ReactNode;
  /** Project override of an app setting; with `onReset` shows a ghost Reset. */
  overridden?: boolean;
  onReset?: () => void;
  inv?: boolean;
  on?: boolean;
}

export const LabelValueRow = forwardRef<HTMLDivElement, LabelValueRowProps>(function LabelValueRow(
  { label, control, overridden, onReset, inv, on, className, ...rest },
  ref,
) {
  const cls = [s['row'], className].filter(Boolean).join(' ');
  return (
    <div
      ref={ref}
      className={cls}
      data-overridden={overridden ? 'true' : undefined}
      data-inv={inv ? 'true' : undefined}
      data-on={on ? 'true' : undefined}
      {...rest}
    >
      <span className={s['label']}>{label}</span>
      <span className={s['value']}>
        {overridden && onReset ? (
          <Button variant="ghost" size="compact" onClick={onReset}>
            Reset
          </Button>
        ) : null}
        {control}
      </span>
    </div>
  );
});

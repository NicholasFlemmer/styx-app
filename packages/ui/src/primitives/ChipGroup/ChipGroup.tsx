import { forwardRef, useRef, type HTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import s from './ChipGroup.module.css';

export interface ChipOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}
export type ChipLayout = 'grid' | 'inline';
/** duration = 4-up grid chips (once / 1h / session / always); env = inline env chips (dev / preview / prod). */
export type ChipSize = 'duration' | 'env';

export interface ChipGroupProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  options: ChipOption[];
  value: string | null;
  onChange: (value: string) => void;
  layout?: ChipLayout;
  size?: ChipSize;
  inv?: boolean;
  on?: boolean;
}

export const ChipGroup = forwardRef<HTMLDivElement, ChipGroupProps>(function ChipGroup(
  { options, value, onChange, layout = 'grid', size = 'duration', inv, on, className, style, ...rest },
  ref,
) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = options.filter((o) => !o.disabled);
  const firstTabbable = enabled.some((o) => o.value === value) ? value : (enabled[0]?.value ?? null);

  const move = (from: number, delta: number) => {
    if (options.length === 0) return;
    let i = from;
    for (let n = 0; n < options.length; n += 1) {
      i = (i + delta + options.length) % options.length;
      const o = options[i];
      if (o && !o.disabled) {
        onChange(o.value);
        buttons.current[i]?.focus();
        return;
      }
    }
  };
  const jump = (to: 'first' | 'last') => {
    const idx = to === 'first' ? options.findIndex((o) => !o.disabled) : options.length - 1 - [...options].reverse().findIndex((o) => !o.disabled);
    const o = options[idx];
    if (o) {
      onChange(o.value);
      buttons.current[idx]?.focus();
    }
  };
  const onKeyDown = (i: number) => (e: KeyboardEvent<HTMLButtonElement>) => {
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault();
        move(i, 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        move(i, -1);
        break;
      case 'Home':
        e.preventDefault();
        jump('first');
        break;
      case 'End':
        e.preventDefault();
        jump('last');
        break;
      default:
    }
  };

  const cls = [s['group'], layout === 'grid' ? s['grid'] : s['inline'], className].filter(Boolean).join(' ');
  const gridStyle = layout === 'grid' ? { ...style, gridTemplateColumns: `repeat(${options.length}, 1fr)` } : style;
  return (
    <div
      ref={ref}
      role="radiogroup"
      className={cls}
      style={gridStyle}
      data-inv={inv ? 'true' : undefined}
      data-on={on ? 'true' : undefined}
      {...rest}
    >
      {options.map((o, i) => {
        const chosen = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              buttons.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={chosen}
            tabIndex={o.value === firstTabbable ? 0 : -1}
            disabled={o.disabled}
            className={[s['chip'], s[size]].filter(Boolean).join(' ')}
            data-on={chosen ? 'true' : undefined}
            onClick={() => onChange(o.value)}
            onKeyDown={onKeyDown(i)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
});

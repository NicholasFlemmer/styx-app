import { createElement, forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import s from './Label.module.css';

export type LabelElement = 'span' | 'div' | 'label' | 'h2' | 'h3' | 'legend' | 'p';

export interface LabelProps extends HTMLAttributes<HTMLElement> {
  /** Element to render; `label` pairs with `htmlFor`. */
  as?: LabelElement;
  /** t-label-strong: 700 and inherits colour (section tabs, sheet header). */
  strong?: boolean;
  htmlFor?: string;
  inv?: boolean;
  on?: boolean;
  children?: ReactNode;
}

/** t-label: 600 10px .1em uppercase --mu (or strong: 700, inherit colour). */
export const Label = forwardRef<HTMLElement, LabelProps>(function Label(
  { as = 'span', strong, inv, on, className, htmlFor, ...rest },
  ref,
) {
  const cls = [s['label'], strong && s['strong'], className].filter(Boolean).join(' ');
  return createElement(as, {
    ref,
    className: cls,
    htmlFor: as === 'label' ? htmlFor : undefined,
    'data-inv': inv ? 'true' : undefined,
    'data-on': on ? 'true' : undefined,
    ...rest,
  });
});

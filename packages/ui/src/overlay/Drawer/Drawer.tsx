import { forwardRef, useId, useRef, type HTMLAttributes, type ReactNode, type RefObject } from 'react';
import { Icon } from '../../primitives';
import { useEscape, useFocusTrap, useOverflows, useReturnFocus } from '../../hooks';
import { SheetFooter } from '../Sheet';
import s from './Drawer.module.css';

export interface DrawerProps {
  /** Header-row label (t-label), e.g. "Audit entry". */
  heading: ReactNode;
  /** 20px title, e.g. "Granted Codex write on Supabase prod". */
  title?: ReactNode;
  /** Mono meta line under the title, e.g. "14:02 · Codex → supabase-prod". */
  meta?: ReactNode;
  /** Footer buttons (footer Buttons); wrapped in `SheetFooter`. */
  footer?: ReactNode;
  labelledBy?: string;
  onClose: () => void;
  escapeEnabled?: boolean;
  initialFocus?: 'first' | RefObject<HTMLElement | null>;
  children?: ReactNode;
}

/** Right-anchored detail drawer (audit entry), 380px; header row with ✕, DrawerRow label/value rows. */
export const Drawer = forwardRef<HTMLDivElement, DrawerProps>(function Drawer(
  {
    heading,
    title,
    meta,
    footer,
    labelledBy,
    onClose,
    escapeEnabled = true,
    initialFocus = 'first',
    children,
  },
  ref,
) {
  const inner = useRef<HTMLDivElement | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  const bodyScrolls = useOverflows(body);
  const headingId = useId();
  useReturnFocus(true);
  useFocusTrap(inner, { active: true, initialFocus });
  useEscape(true, onClose, escapeEnabled);
  const setRef = (node: HTMLDivElement | null) => {
    inner.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  };

  return (
    <div
      ref={setRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy ?? headingId}
      tabIndex={-1}
      className={s['drawer']}
    >
      <div className={s['header']}>
        <span id={headingId} className={s['heading']}>
          {heading}
        </span>
        <button type="button" className={s['close']} aria-label="Close" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </div>
      {title !== undefined && <div className={s['title']}>{title}</div>}
      {meta !== undefined && <div className={s['meta']}>{meta}</div>}
      <div ref={body} className={s['body']} tabIndex={bodyScrolls ? 0 : undefined}>
        {children}
      </div>
      {footer !== undefined && footer !== null && <SheetFooter>{footer}</SheetFooter>}
    </div>
  );
});

export interface DrawerRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  label: ReactNode;
  /** Mono 12px value. */
  children?: ReactNode;
}

/** label / value row: 110px label column, hairline top, 9px 16px. */
export function DrawerRow({ label, children, className, ...rest }: DrawerRowProps) {
  return (
    <div className={[s['row'], className].filter(Boolean).join(' ')} {...rest}>
      <span className={s['rowLabel']}>{label}</span>
      <span className={s['rowValue']}>{children}</span>
    </div>
  );
}

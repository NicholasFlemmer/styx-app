import { forwardRef, useId, useRef, type HTMLAttributes, type ReactNode, type RefObject } from 'react';
import { useEscape, useFocusTrap, useOverflows, useReturnFocus } from '../../hooks';
import s from './Sheet.module.css';

export interface SheetProps {
  /** Header bar above the title, e.g. `<SheetAccentHeader label="Access request" meta="Codex · test/flaky" />`. */
  header?: ReactNode;
  /** 22px display title, e.g. "Supabase / prod db". */
  title?: ReactNode;
  /** Footer row, usually `<SheetFooter>` with footer Buttons. */
  footer?: ReactNode;
  labelledBy?: string;
  onClose: () => void;
  /** Pass false while a nested overlay owns Esc. */
  escapeEnabled?: boolean;
  initialFocus?: 'first' | RefObject<HTMLElement | null>;
  children?: ReactNode;
}

/** Right-anchored slide-over (grant sheet), 360px, no backdrop; focus trapped, Esc closes (spec §8). */
export const Sheet = forwardRef<HTMLDivElement, SheetProps>(function Sheet(
  { header, title, footer, labelledBy, onClose, escapeEnabled = true, initialFocus = 'first', children },
  ref,
) {
  const inner = useRef<HTMLDivElement | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  const bodyScrolls = useOverflows(body);
  const titleId = useId();
  useReturnFocus(true);
  useFocusTrap(inner, { active: true, initialFocus });
  useEscape(true, onClose, escapeEnabled);
  const setRef = (node: HTMLDivElement | null) => {
    inner.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  };
  const label = labelledBy ?? (title !== undefined ? titleId : undefined);

  return (
    <div
      ref={setRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={label}
      tabIndex={-1}
      className={s['sheet']}
    >
      {header}
      {title !== undefined && (
        <div id={titleId} className={s['title']}>
          {title}
        </div>
      )}
      {/* Tabbable only while it scrolls, so keyboard users can reach overflowing content (no extra stop otherwise). */}
      <div ref={body} className={s['body']} tabIndex={bodyScrolls ? 0 : undefined}>
        {children}
      </div>
      {footer}
    </div>
  );
});

export interface SheetAccentHeaderProps extends HTMLAttributes<HTMLDivElement> {
  /** Left text, e.g. "Access request". */
  label: ReactNode;
  /** Right text, e.g. "Codex · test/flaky". */
  meta?: ReactNode;
}

/** Accent header bar: `--ac` fill, `--acx` text, 700 10px .1em uppercase. */
export function SheetAccentHeader({ label, meta, className, ...rest }: SheetAccentHeaderProps) {
  return (
    <div className={[s['accent'], className].filter(Boolean).join(' ')} {...rest}>
      <span>{label}</span>
      {meta !== undefined && <span>{meta}</span>}
    </div>
  );
}

export interface SheetFooterProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

/** Footer button row: hairline top, hairline between footer Buttons. Also used by Drawer. */
export function SheetFooter({ className, children, ...rest }: SheetFooterProps) {
  return (
    <div className={[s['footer'], className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </div>
  );
}

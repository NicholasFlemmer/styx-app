import { forwardRef, useId, useRef, type ReactNode, type RefObject } from 'react';
import { Icon } from '../../primitives';
import { useEscape, useFocusTrap, useReturnFocus } from '../../hooks';
import { Backdrop } from '../Backdrop';
import s from './Modal.module.css';

export interface ModalProps {
  /** 560 = connect (`--w-modal-connect`) · 600 = spawn / new project (`--w-modal-spawn`). */
  width?: 560 | 600;
  /** Backdrop top anchor: 90 for connect / spawn (spec §8), 70 for new project (prototype). */
  top?: 70 | 90;
  /** Header label, e.g. "Connect target · Pick a provider". Rendered as t-label. */
  title: ReactNode;
  onClose: () => void;
  /** Footer buttons; a flex:1 spacer precedes them. Use `Button size="footer"`. */
  footer?: ReactNode;
  /** Overrides the auto-generated title id for aria-labelledby. */
  labelledBy?: string;
  /** '16px' (spawn / new project) or '20px 16px' (connect steps). */
  bodyPad?: '16px' | '20px 16px';
  /** Pass false while a nested overlay owns Esc. */
  escapeEnabled?: boolean;
  initialFocus?: 'first' | RefObject<HTMLElement | null>;
  children?: ReactNode;
}

/** Top-anchored dialog at 90px with backdrop; Esc and backdrop click close (spec §8). */
export const Modal = forwardRef<HTMLDivElement, ModalProps>(function Modal(
  {
    width = 560,
    top = 90,
    title,
    onClose,
    footer,
    labelledBy,
    bodyPad = '16px',
    escapeEnabled = true,
    initialFocus = 'first',
    children,
  },
  ref,
) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useReturnFocus(true);
  useFocusTrap(panel, { active: true, initialFocus });
  useEscape(true, onClose, escapeEnabled);

  return (
    <Backdrop ref={ref} paddingTop={top} onClose={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? titleId}
        tabIndex={-1}
        className={[s['panel'], width === 600 ? s['w600'] : s['w560']].join(' ')}
      >
        <div className={s['header']}>
          <span id={titleId} className={s['title']}>
            {title}
          </span>
          <button type="button" className={s['close']} aria-label="Close" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className={[s['body'], bodyPad === '20px 16px' ? s['bodyLoose'] : ''].filter(Boolean).join(' ')}>
          {children}
        </div>
        {footer !== undefined && footer !== null && (
          <div className={s['footer']}>
            <span className={s['spacer']} />
            {footer}
          </div>
        )}
      </div>
    </Backdrop>
  );
});

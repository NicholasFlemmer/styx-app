import { forwardRef, type HTMLAttributes, type MouseEvent } from 'react';
import s from './Backdrop.module.css';

export interface BackdropProps extends HTMLAttributes<HTMLDivElement> {
  /** Modal 90 · palette 110 (spec §8: modals top-anchored at 90px). */
  paddingTop?: number;
  /** Fires on a click on the dim itself; clicks inside the panel never close. */
  onClose?: () => void;
}

/** Dim layer behind Modal and Palette only. Sheets, drawers and toasts have no backdrop. */
export const Backdrop = forwardRef<HTMLDivElement, BackdropProps>(function Backdrop(
  { paddingTop = 90, onClose, onClick, className, style, children, ...rest },
  ref,
) {
  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    onClick?.(e);
    if (e.target === e.currentTarget) onClose?.();
  };
  return (
    <div
      ref={ref}
      className={[s['backdrop'], className].filter(Boolean).join(' ')}
      style={{ ...style, paddingTop }}
      onClick={handleClick}
      data-backdrop="true"
      {...rest}
    >
      {children}
    </div>
  );
});

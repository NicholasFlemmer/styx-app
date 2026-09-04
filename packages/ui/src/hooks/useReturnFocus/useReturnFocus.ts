import { useEffect, useRef, useState } from 'react';

function currentFocus(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

/**
 * Captures the invoker (`document.activeElement`) when `active` turns on and restores it (next frame) when it
 * turns off or the caller unmounts — only if it is still in the document (spec §9: Esc returns focus to the invoker).
 * Capture happens at first render, before children `autoFocus` and focus traps run; call this hook before
 * `useFocusTrap` so re-activation captures first too.
 */
export function useReturnFocus(active: boolean): void {
  const [initial] = useState(() => (active ? currentFocus() : null));
  const invoker = useRef<HTMLElement | null>(initial);
  useEffect(() => {
    if (!active) return;
    if (invoker.current === null) invoker.current = currentFocus();
    return () => {
      const target = invoker.current;
      invoker.current = null;
      if (!target) return;
      const restore = () => {
        if (target.isConnected) target.focus();
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
      else setTimeout(restore, 0);
    };
  }, [active]);
}

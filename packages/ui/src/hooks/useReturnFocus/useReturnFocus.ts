import { useEffect } from 'react';

/**
 * Captures `document.activeElement` when `active` turns on and restores it (next frame) when it turns
 * off or the caller unmounts — only if that element is still in the document (spec §9: Esc returns focus to the invoker).
 */
export function useReturnFocus(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (!invoker) return;
      const restore = () => {
        if (invoker.isConnected) invoker.focus();
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
      else setTimeout(restore, 0);
    };
  }, [active]);
}

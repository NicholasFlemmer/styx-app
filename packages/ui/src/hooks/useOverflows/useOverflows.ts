import { useLayoutEffect, useState, type RefObject } from 'react';

function overflows(el: HTMLElement): boolean {
  return el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth;
}

/**
 * True while `ref`'s content overflows its box. Overlays use it to make a scrollable body tabbable only when it
 * actually scrolls, so keyboard users can reach it (axe `scrollable-region-focusable`) without adding a tab stop
 * to sheets whose content fits. Re-measures on box resize and content mutations; no-op outside the DOM.
 */
export function useOverflows(ref: RefObject<HTMLElement | null>): boolean {
  const [state, setState] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setState(overflows(el));
    measure();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(measure);
    mo?.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [ref]);
  return state;
}

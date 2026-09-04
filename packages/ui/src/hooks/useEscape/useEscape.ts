import { useEffect, useRef } from 'react';

type Handler = () => void;

/** Stack of active handlers; only the topmost (most recently activated) overlay owns Esc. */
const stack: Handler[] = [];
let listening = false;

function onDocumentKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  e.preventDefault();
  e.stopPropagation();
  top();
}

/**
 * Calls `onEscape` on Escape keydown (document level) while `active && enabled`.
 * Nested overlays: the most recently activated one handles Esc; the others do not see it.
 */
export function useEscape(active: boolean, onEscape: Handler, enabled = true): void {
  const latest = useRef<Handler>(onEscape);
  useEffect(() => {
    latest.current = onEscape;
  });
  useEffect(() => {
    if (!active || !enabled) return;
    const handler: Handler = () => latest.current();
    stack.push(handler);
    if (!listening) {
      document.addEventListener('keydown', onDocumentKeyDown);
      listening = true;
    }
    return () => {
      const i = stack.lastIndexOf(handler);
      if (i >= 0) stack.splice(i, 1);
      if (stack.length === 0 && listening) {
        document.removeEventListener('keydown', onDocumentKeyDown);
        listening = false;
      }
    };
  }, [active, enabled]);
}

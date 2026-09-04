import { useEffect, type RefObject } from 'react';

const TABBABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface FocusTrapOptions {
  /** Trap is only installed while active. */
  active: boolean;
  /** Element focused on activation: the first tabbable (default) or a specific ref. */
  initialFocus?: 'first' | RefObject<HTMLElement | null>;
}

export function tabbablesWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (el) => el.getAttribute('aria-hidden') !== 'true' && !el.hidden,
  );
}

/**
 * Keeps Tab / Shift+Tab inside `ref` while `active` (spec §9: focus trapped inside modals and sheet).
 * The root should carry `tabIndex={-1}` so it can take focus when it has no tabbable children.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, { active, initialFocus = 'first' }: FocusTrapOptions): void {
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;

    const target = initialFocus === 'first' ? tabbablesWithin(root)[0] : initialFocus.current;
    (target ?? root).focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const list = tabbablesWithin(root);
      const first = list[0];
      const last = list[list.length - 1];
      if (!first || !last) {
        e.preventDefault();
        root.focus();
        return;
      }
      const current = document.activeElement;
      const inside = current instanceof Node && root.contains(current);
      if (e.shiftKey) {
        if (!inside || current === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (!inside || current === last) {
        e.preventDefault();
        first.focus();
      }
    };
    root.addEventListener('keydown', onKeyDown);
    return () => root.removeEventListener('keydown', onKeyDown);
  }, [ref, active, initialFocus]);
}

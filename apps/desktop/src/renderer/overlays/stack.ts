import type { AskId, AuditId, ProjectId, Provider, SessionId, TargetId } from '@styx/core';

/** Overlay kinds and their z-order / behaviour (plan §8 Overlays). */
export type OverlayKind = 'palette' | 'modal' | 'sheet' | 'drawer' | 'toast';

export type ToastPayload =
  | { kind: 'ask'; askId: AskId; sessionId: SessionId; projectId: ProjectId }
  | { kind: 'error'; code: string; message: string };

export type ModalPayload =
  | { modal: 'spawn'; projectId: ProjectId }
  | { modal: 'new-project' }
  /** projectId is null during onboarding (no project yet); provider/targetId preselect the flow (Reconnect, step 4). */
  | { modal: 'connect'; projectId: ProjectId | null; provider?: Provider; targetId?: TargetId };

export type Overlay =
  | { id: string; kind: 'palette' }
  | ({ id: string; kind: 'modal' } & ModalPayload)
  | { id: string; kind: 'sheet'; sheet: 'grant'; sessionId: SessionId; askId: AskId }
  | { id: string; kind: 'drawer'; drawer: 'audit'; auditId: AuditId }
  | { id: string; kind: 'toast'; toast: ToastPayload };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** What callers push: the stack assigns the id. */
export type OverlayInput = DistributiveOmit<Overlay, 'id'>;

export interface OverlayTraits {
  z: number;
  /** Focus-trapping overlays make `#layer-app` inert. */
  trap: boolean;
  /** `--dim` backdrop. */
  dim: boolean;
}

export const OVERLAY_TRAITS: Record<OverlayKind, OverlayTraits> = {
  palette: { z: 40, trap: true, dim: true },
  modal: { z: 30, trap: true, dim: true },
  toast: { z: 20, trap: false, dim: false },
  sheet: { z: 10, trap: true, dim: false },
  drawer: { z: 10, trap: true, dim: false },
};

let counter = 0;
export const overlayId = (kind: OverlayKind): string => `${kind}-${++counter}`;

/** Push keeps the stack sorted by z (stable within a z); at most one modal and one palette. */
export const pushOverlay = (stack: readonly Overlay[], overlay: Overlay): Overlay[] => {
  const base = stack.filter((o) => {
    if (overlay.kind === 'modal' && o.kind === 'modal') return false;
    if (overlay.kind === 'palette' && o.kind === 'palette') return false;
    return true;
  });
  const next = [...base, overlay];
  return next.sort((a, b) => OVERLAY_TRAITS[a.kind].z - OVERLAY_TRAITS[b.kind].z);
};

export const topOverlay = (stack: readonly Overlay[]): Overlay | null => stack[stack.length - 1] ?? null;

export const removeOverlay = (stack: readonly Overlay[], id: string): Overlay[] =>
  stack.filter((o) => o.id !== id);

export const isTrapping = (stack: readonly Overlay[]): boolean =>
  stack.some((o) => OVERLAY_TRAITS[o.kind].trap);

/**
 * The overlay Esc should close (spec §6 "Close overlay: palette, modals, sheet, drawer, toast"): the topmost
 * *trapping* overlay owns the keyboard, so it goes first; a toast is only popped when nothing traps.
 */
export const escapeTarget = (stack: readonly Overlay[]): Overlay | null => {
  for (let i = stack.length - 1; i >= 0; i--) {
    const o = stack[i];
    if (o !== undefined && OVERLAY_TRAITS[o.kind].trap) return o;
  }
  return topOverlay(stack);
};

export const findOverlay = <K extends OverlayKind>(
  stack: readonly Overlay[],
  kind: K,
): Extract<Overlay, { kind: K }> | null => {
  for (let i = stack.length - 1; i >= 0; i--) {
    const o = stack[i];
    if (o !== undefined && o.kind === kind) return o as Extract<Overlay, { kind: K }>;
  }
  return null;
};

// --- Invoker focus return -------------------------------------------------

const invokers = new Map<string, WeakRef<HTMLElement>>();

const activeElement = (): HTMLElement | null =>
  typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;

/** Records the element that had focus when `id` was pushed. */
export const rememberInvoker = (id: string, el: HTMLElement | null = activeElement()): void => {
  if (el !== null && typeof WeakRef === 'function') invokers.set(id, new WeakRef(el));
};

export const invokerOf = (id: string): HTMLElement | null => invokers.get(id)?.deref() ?? null;

/**
 * Restores focus to the invoker (next frame, only if still in the document). When the invoker sits inside the
 * editor scope the scope root takes focus so Monaco can re-focus itself (plan §8: `editor.focus()`).
 */
export const restoreInvoker = (id: string): void => {
  const target = invokerOf(id);
  invokers.delete(id);
  if (target === null) return;
  const editor = target.closest<HTMLElement>('[data-keyscope="editor"]');
  const focusTarget = editor ?? target;
  const restore = () => {
    if (focusTarget.isConnected) focusTarget.focus();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
  else restore();
};

export const forgetInvoker = (id: string): void => {
  invokers.delete(id);
};

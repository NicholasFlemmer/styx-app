/**
 * Key scopes (plan §8 Keyboard): `overlay > palette > composer|editor|terminal > diff|workspace|chat > global`.
 * A DOM subtree declares its scope with `data-keyscope`; the active chain is read from the event target up.
 */
export type KeyScope =
  'global' | 'overlay' | 'palette' | 'workspace' | 'chat' | 'composer' | 'editor' | 'terminal' | 'diff';

export const KEY_SCOPES: readonly KeyScope[] = [
  'global',
  'overlay',
  'palette',
  'workspace',
  'chat',
  'composer',
  'editor',
  'terminal',
  'diff',
];

export const isKeyScope = (v: string): v is KeyScope => (KEY_SCOPES as readonly string[]).includes(v);

/** Scopes whose host widget (Monaco, xterm, the composer textarea) owns every non-RESERVED chord. */
export const HOST_OWNED: readonly KeyScope[] = ['editor', 'terminal', 'composer'];

export const SCOPE_ATTR = 'data-keyscope';

/**
 * Innermost-first chain of scopes for a target, always ending in `global`. When an overlay is open and the
 * chain does not already pass through one, `overlay` is prepended so Esc reaches the stack even from `body`.
 */
export const scopeChain = (target: EventTarget | null, overlayOpen: boolean): KeyScope[] => {
  const chain: KeyScope[] = [];
  let el: Element | null = target instanceof Element ? target : null;
  while (el !== null) {
    const scoped: Element | null = el.closest(`[${SCOPE_ATTR}]`);
    if (scoped === null) break;
    const raw = scoped.getAttribute(SCOPE_ATTR) ?? '';
    if (isKeyScope(raw) && !chain.includes(raw)) chain.push(raw);
    el = scoped.parentElement;
  }
  if (overlayOpen && !chain.includes('overlay') && !chain.includes('palette')) chain.unshift('overlay');
  if (overlayOpen && chain.includes('palette') && !chain.includes('overlay')) {
    chain.splice(chain.indexOf('palette') + 1, 0, 'overlay');
  }
  if (!chain.includes('global')) chain.push('global');
  return chain;
};

export const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'range', 'file'].includes(type);
  }
  return false;
};

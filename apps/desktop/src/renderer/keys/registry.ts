import { isReserved, matchesEvent, parseChord, type Chord, type Platform } from '@styx/core';
import { HOST_OWNED, isEditableTarget, scopeChain, type KeyScope } from './scopes';

export interface KeyContext {
  event: KeyboardEvent;
  platform: Platform;
  chain: readonly KeyScope[];
}

export interface KeyBinding {
  id: string;
  /** "Mod+K", "a", "Escape" (core chord grammar). */
  chord: string;
  scope: KeyScope;
  /** Extra gate evaluated at dispatch time. */
  when?: (ctx: KeyContext) => boolean;
  /** Return `false` to let the event continue (not handled). */
  run: (ctx: KeyContext) => void | boolean;
}

interface Registered extends KeyBinding {
  parsed: Chord;
  reserved: boolean;
}

const isPlain = (c: Chord): boolean => !c.mod && !c.ctrl && !c.alt;

export interface KeyRegistryOptions {
  platform: () => Platform;
  overlayOpen: () => boolean;
}

/**
 * Single capture-phase keydown dispatcher (plan §8 Keyboard). Resolution order: innermost scope first,
 * then outward to `global`; first matching binding wins and stops the event.
 *
 * Pass-through rules: inside `editor`/`terminal`/`composer` only RESERVED chords are dispatched (Monaco/xterm
 * own plain keys, Enter, Mod+Enter/Backspace); in the composer Mod+Enter/Mod+Backspace still bubble to `chat`.
 * Plain keys never fire while an editable element is focused.
 */
export class KeyRegistry {
  private readonly bindings: Registered[] = [];
  private readonly opts: KeyRegistryOptions;

  constructor(opts: KeyRegistryOptions) {
    this.opts = opts;
  }

  register(binding: KeyBinding): () => void {
    const entry: Registered = {
      ...binding,
      parsed: parseChord(binding.chord),
      reserved: isReserved(binding.chord),
    };
    this.bindings.push(entry);
    return () => {
      const i = this.bindings.indexOf(entry);
      if (i >= 0) this.bindings.splice(i, 1);
    };
  }

  registerAll(bindings: readonly KeyBinding[]): () => void {
    const offs = bindings.map((b) => this.register(b));
    return () => offs.forEach((off) => off());
  }

  list(): readonly KeyBinding[] {
    return this.bindings;
  }

  /** Returns true when a binding handled the event. */
  dispatch(event: KeyboardEvent): boolean {
    if (event.defaultPrevented) return false;
    if (event.isComposing) return false;
    const platform = this.opts.platform();
    const chain = scopeChain(event.target, this.opts.overlayOpen());
    const innermost = chain[0] ?? 'global';
    const hostOwned = HOST_OWNED.includes(innermost);
    const editable = isEditableTarget(event.target);
    const ctx: KeyContext = { event, platform, chain };
    for (const scope of chain) {
      for (const b of this.bindings) {
        if (b.scope !== scope) continue;
        if (!matchesEvent(b.parsed, event, platform)) continue;
        if (hostOwned && !b.reserved) {
          const chatChordFromComposer = innermost === 'composer' && b.scope !== 'composer' && b.parsed.mod;
          if (!chatChordFromComposer) continue;
        }
        if (editable && isPlain(b.parsed) && b.parsed.key !== 'Escape') continue;
        if (b.when !== undefined && !b.when(ctx)) continue;
        const handled = b.run(ctx);
        if (handled === false) continue;
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
    }
    return false;
  }

  /** Installs the capture-phase listener on `target` (window by default). */
  install(target: EventTarget = window): () => void {
    const handler = (e: Event) => {
      if (e instanceof KeyboardEvent) this.dispatch(e);
    };
    target.addEventListener('keydown', handler, true);
    return () => target.removeEventListener('keydown', handler, true);
  }
}

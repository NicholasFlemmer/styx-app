import { shortcuts } from '@styx/tokens';
import type { Platform } from '../model/common';

/** `Mod` = ⌘ on macOS, Ctrl on Windows. */
export interface Chord {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
  /** Literal Ctrl (rare; only for chords that must be Ctrl on both platforms). */
  ctrl: boolean;
}

export interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

const NAMED_KEYS: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  backspace: 'Backspace',
  escape: 'Escape',
  esc: 'Escape',
  tab: 'Tab',
  space: ' ',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
};

const normalizeKey = (raw: string): string => {
  const lower = raw.toLowerCase();
  const named = NAMED_KEYS[lower];
  if (named !== undefined) return named;
  return lower;
};

/** Parse "Mod+Shift+O", "a", "Escape". Modifier order is free; the last token is the key. */
export const parseChord = (text: string): Chord => {
  const parts = text
    .split('+')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const chord: Chord = { key: '', mod: false, shift: false, alt: false, ctrl: false };
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'mod' || lower === 'cmdorctrl' || lower === 'cmd' || lower === 'meta') chord.mod = true;
    else if (lower === 'shift') chord.shift = true;
    else if (lower === 'alt' || lower === 'option') chord.alt = true;
    else if (lower === 'ctrl' || lower === 'control') chord.ctrl = true;
    else chord.key = normalizeKey(part);
  }
  if (chord.key === '') throw new Error(`chord "${text}" has no key`);
  return chord;
};

const eventKey = (key: string): string => normalizeKey(key.length === 1 ? key : key);

/** Match a DOM keydown against a chord for the platform. Mod maps to metaKey (darwin) / ctrlKey (win32). */
export const matchesEvent = (chord: Chord, event: KeyEventLike, platform: Platform): boolean => {
  const modDown = platform === 'darwin' ? event.metaKey : event.ctrlKey;
  const otherMod = platform === 'darwin' ? event.ctrlKey : event.metaKey;
  if (eventKey(event.key) !== chord.key) return false;
  if (modDown !== chord.mod) return false;
  if (event.shiftKey !== chord.shift) return false;
  if (event.altKey !== chord.alt) return false;
  if (otherMod !== chord.ctrl) return false;
  return true;
};

const MAC_KEY_GLYPH: Record<string, string> = {
  Enter: '⏎',
  Backspace: '⌫',
  Tab: '⇥',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  ' ': 'Space',
};

const WIN_KEY_WORD: Record<string, string> = {
  Enter: 'Enter',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Escape: 'Esc',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ' ': 'Space',
};

const keyLabel = (key: string, platform: Platform): string => {
  const table = platform === 'darwin' ? MAC_KEY_GLYPH : WIN_KEY_WORD;
  const named = table[key];
  if (named !== undefined) return named;
  return key.length === 1 || /^f\d{1,2}$/.test(key) ? key.toUpperCase() : key;
};

/** "⌘⇧O" on macOS, "Ctrl+Shift+O" on Windows (spec §7 modifier glyphs). */
export const formatChord = (chord: Chord | string, platform: Platform): string => {
  const c = typeof chord === 'string' ? parseChord(chord) : chord;
  if (platform === 'darwin') {
    let out = '';
    if (c.ctrl) out += '⌃';
    if (c.alt) out += '⌥';
    if (c.mod) out += '⌘';
    if (c.shift) out += '⇧';
    return out + keyLabel(c.key, platform);
  }
  const parts: string[] = [];
  if (c.mod || c.ctrl) parts.push('Ctrl');
  if (c.alt) parts.push('Alt');
  if (c.shift) parts.push('Shift');
  parts.push(keyLabel(c.key, platform));
  return parts.join('+');
};

/** Chords that pass through Monaco/xterm untouched (plan §8 Keyboard). */
export const RESERVED: readonly string[] = [
  'Mod+K',
  'Mod+P',
  'Mod+1',
  'Mod+2',
  'Mod+3',
  'Mod+4',
  'Mod+Shift+O',
  'Mod+Shift+N',
  'Mod+Shift+T',
];

export const isReserved = (chord: Chord | string): boolean => {
  const c = typeof chord === 'string' ? parseChord(chord) : chord;
  return RESERVED.some((r) => {
    const rc = parseChord(r);
    return (
      rc.key === c.key && rc.mod === c.mod && rc.shift === c.shift && rc.alt === c.alt && rc.ctrl === c.ctrl
    );
  });
};

export type KeyScope = 'global' | 'workspace' | 'chat' | 'diff' | 'composer' | 'palette' | 'overlay';

export interface Binding {
  id: string;
  chord: Chord;
  raw: string;
  scope: KeyScope;
}

const SCOPE_OF: Record<keyof typeof shortcuts, KeyScope> = {
  palette: 'global',
  switchProject: 'global',
  focusAgent: 'workspace',
  popoutChat: 'workspace',
  approve: 'chat',
  deny: 'chat',
  diffAccept: 'diff',
  diffReject: 'diff',
  diffNext: 'diff',
  diffPrev: 'diff',
  diffDone: 'diff',
  spawnAgent: 'global',
  toggleTheme: 'global',
  close: 'overlay',
};

/** Bindings from `@styx/tokens` shortcuts (spec §6), one per chord; arrays expand to `<id>:<n>`. */
export const bindingsFromTokens = (): Binding[] => {
  const out: Binding[] = [];
  for (const [id, value] of Object.entries(shortcuts) as [
    keyof typeof shortcuts,
    string | readonly string[],
  ][]) {
    const scope = SCOPE_OF[id];
    if (typeof value === 'string') {
      out.push({ id, chord: parseChord(value), raw: value, scope });
    } else {
      value.forEach((raw, i) => out.push({ id: `${id}:${i + 1}`, chord: parseChord(raw), raw, scope }));
    }
  }
  return out;
};

/** Ctrl+Alt collides with AltGr on Windows (spec §6). */
export const usesCtrlAlt = (chord: Chord): boolean => chord.alt && (chord.mod || chord.ctrl);

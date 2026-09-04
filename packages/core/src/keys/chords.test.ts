import { describe, expect, it } from 'vitest';
import { shortcuts } from '@styx/tokens';
import {
  RESERVED,
  bindingsFromTokens,
  formatChord,
  isReserved,
  matchesEvent,
  parseChord,
  usesCtrlAlt,
} from './chords';
import type { KeyEventLike } from './chords';

const ev = (over: Partial<KeyEventLike> & Pick<KeyEventLike, 'key'>): KeyEventLike => ({
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

describe('parseChord', () => {
  it.each([
    ['Mod+K', { key: 'k', mod: true, shift: false, alt: false, ctrl: false }],
    ['Mod+Shift+O', { key: 'o', mod: true, shift: true, alt: false, ctrl: false }],
    ['Mod+Enter', { key: 'Enter', mod: true, shift: false, alt: false, ctrl: false }],
    ['Mod+Backspace', { key: 'Backspace', mod: true, shift: false, alt: false, ctrl: false }],
    ['Escape', { key: 'Escape', mod: false, shift: false, alt: false, ctrl: false }],
    ['Esc', { key: 'Escape', mod: false, shift: false, alt: false, ctrl: false }],
    ['a', { key: 'a', mod: false, shift: false, alt: false, ctrl: false }],
    ['Mod+1', { key: '1', mod: true, shift: false, alt: false, ctrl: false }],
    ['Ctrl+Alt+Tab', { key: 'Tab', mod: false, shift: false, alt: true, ctrl: true }],
    ['CmdOrCtrl+Option+Up', { key: 'ArrowUp', mod: true, shift: false, alt: true, ctrl: false }],
    ['Shift+Space', { key: ' ', mod: false, shift: true, alt: false, ctrl: false }],
  ])('%s', (text, expected) => {
    expect(parseChord(text)).toEqual(expected);
  });
  it('rejects chords without a key', () => {
    expect(() => parseChord('Mod+Shift')).toThrow('has no key');
  });
});

describe('matchesEvent', () => {
  const mk = parseChord('Mod+K');
  const mso = parseChord('Mod+Shift+O');
  it('Mod is ⌘ on macOS and Ctrl on Windows', () => {
    expect(matchesEvent(mk, ev({ key: 'k', metaKey: true }), 'darwin')).toBe(true);
    expect(matchesEvent(mk, ev({ key: 'k', ctrlKey: true }), 'darwin')).toBe(false);
    expect(matchesEvent(mk, ev({ key: 'k', ctrlKey: true }), 'win32')).toBe(true);
    expect(matchesEvent(mk, ev({ key: 'k', metaKey: true }), 'win32')).toBe(false);
  });
  it('checks every modifier and the key', () => {
    expect(matchesEvent(mso, ev({ key: 'O', metaKey: true, shiftKey: true }), 'darwin')).toBe(true);
    expect(matchesEvent(mso, ev({ key: 'o', metaKey: true }), 'darwin')).toBe(false);
    expect(matchesEvent(mso, ev({ key: 'o', metaKey: true, shiftKey: true, altKey: true }), 'darwin')).toBe(
      false,
    );
    expect(matchesEvent(mk, ev({ key: 'j', metaKey: true }), 'darwin')).toBe(false);
    expect(matchesEvent(mk, ev({ key: 'k', metaKey: true, ctrlKey: true }), 'darwin')).toBe(false);
    expect(matchesEvent(parseChord('Enter'), ev({ key: 'Enter' }), 'win32')).toBe(true);
    expect(matchesEvent(parseChord('a'), ev({ key: 'a', metaKey: true }), 'darwin')).toBe(false);
  });
});

describe('formatChord (spec §7 glyphs)', () => {
  it.each([
    ['Mod+K', '⌘K', 'Ctrl+K'],
    ['Mod+Shift+O', '⌘⇧O', 'Ctrl+Shift+O'],
    ['Mod+Enter', '⌘⏎', 'Ctrl+Enter'],
    ['Mod+Backspace', '⌘⌫', 'Ctrl+Backspace'],
    ['Tab', '⇥', 'Tab'],
    ['Escape', 'Esc', 'Esc'],
    ['a', 'A', 'A'],
    ['Mod+Alt+Up', '⌥⌘↑', 'Ctrl+Alt+Up'],
    ['Ctrl+Shift+F5', '⌃⇧F5', 'Ctrl+Shift+F5'],
    ['Shift+Space', '⇧Space', 'Shift+Space'],
  ])('%s → mac %s / win %s', (chord, mac, win) => {
    expect(formatChord(chord, 'darwin')).toBe(mac);
    expect(formatChord(parseChord(chord), 'win32')).toBe(win);
  });
});

describe('bindings from @styx/tokens', () => {
  const bindings = bindingsFromTokens();
  it('covers every shortcut, expanding arrays', () => {
    expect(bindings.map((b) => b.id)).toEqual([
      'palette',
      'switchProject',
      'focusAgent:1',
      'focusAgent:2',
      'focusAgent:3',
      'focusAgent:4',
      'popoutChat',
      'approve',
      'deny',
      'diffAccept',
      'diffReject',
      'diffNext',
      'diffPrev',
      'diffDone',
      'spawnAgent',
      'toggleTheme',
      'close',
    ]);
    expect(bindings.find((b) => b.id === 'palette')).toEqual({
      id: 'palette',
      chord: parseChord('Mod+K'),
      raw: shortcuts.palette,
      scope: 'global',
    });
    expect(bindings.find((b) => b.id === 'diffAccept')?.scope).toBe('diff');
  });
  it('no binding uses Ctrl+Alt (AltGr collision, spec §6)', () => {
    expect(bindings.filter((b) => usesCtrlAlt(b.chord))).toEqual([]);
    expect(usesCtrlAlt(parseChord('Ctrl+Alt+T'))).toBe(true);
    expect(usesCtrlAlt(parseChord('Mod+Alt+T'))).toBe(true);
    expect(usesCtrlAlt(parseChord('Alt+T'))).toBe(false);
  });
  it('the spec §6 map renders per platform', () => {
    const byId = Object.fromEntries(bindings.map((b) => [b.id, b.chord]));
    expect(formatChord(byId['popoutChat'] ?? 'x', 'darwin')).toBe('⌘⇧O');
    expect(formatChord(byId['approve'] ?? 'x', 'win32')).toBe('Ctrl+Enter');
    expect(formatChord(byId['deny'] ?? 'x', 'darwin')).toBe('⌘⌫');
  });
});

describe('RESERVED', () => {
  it('lists the pass-through chords and matches by normalised chord', () => {
    expect(RESERVED).toEqual([
      'Mod+K',
      'Mod+P',
      'Mod+1',
      'Mod+2',
      'Mod+3',
      'Mod+4',
      'Mod+Shift+O',
      'Mod+Shift+N',
      'Mod+Shift+T',
    ]);
    expect(isReserved('Mod+k')).toBe(true);
    expect(isReserved(parseChord('Shift+Mod+O'))).toBe(true);
    expect(isReserved('Mod+Enter')).toBe(false);
    expect(isReserved('a')).toBe(false);
  });
});

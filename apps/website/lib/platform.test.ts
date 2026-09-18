import { describe, expect, it } from 'vitest';
import { detectPlatform, formatShortcut } from './platform';

describe('detectPlatform', () => {
  it.each([
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 'MacIntel', 'mac'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Win32', 'win'],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', 'Linux x86_64', 'other'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 'iPhone', 'other'],
    ['Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36', 'Linux armv8l', 'other'],
    ['', '', 'other'],
  ])('%s → %s', (ua, plat, expected) => {
    expect(detectPlatform(ua, plat)).toBe(expected);
  });
});

describe('formatShortcut', () => {
  it.each([
    ['Mod+K', 'mac', '⌘K'],
    ['Mod+K', 'win', 'Ctrl+K'],
    ['Mod+Shift+O', 'mac', '⌘⇧O'],
    ['Mod+Shift+O', 'win', 'Ctrl+⇧+O'],
    ['Mod+Enter', 'mac', '⌘⏎'],
    ['Mod+Backspace', 'mac', '⌘⌫'],
    ['Escape', 'mac', 'esc'],
    ['a', 'mac', 'a'],
    ['Mod+1..4', 'mac', '⌘1..4'],
  ])('%s on %s → %s', (chord, platform, expected) => {
    expect(formatShortcut(chord, platform as 'mac' | 'win')).toBe(expected);
  });
});

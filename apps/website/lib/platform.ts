export type Platform = 'mac' | 'win' | 'other';

/** Best-effort desktop platform from the user agent; phones and tablets are 'other' (no build for them). */
export const detectPlatform = (userAgent: string, navigatorPlatform = ''): Platform => {
  const s = `${navigatorPlatform} ${userAgent}`.toLowerCase();
  if (/iphone|ipad|ipod|android/.test(s)) return 'other';
  if (/mac/.test(s)) return 'mac';
  if (/win/.test(s)) return 'win';
  return 'other';
};

/** "Mod+Shift+O" (tokens.json) rendered as the platform's glyphs. */
export const formatShortcut = (chord: string, platform: Platform): string => {
  const glyph: Record<string, string> = {
    mod: platform === 'win' ? 'Ctrl' : '⌘',
    shift: '⇧',
    enter: '⏎',
    backspace: '⌫',
    escape: 'esc',
  };
  return chord
    .split('+')
    .map((k) => glyph[k.toLowerCase()] ?? k)
    .join(platform === 'win' ? '+' : '');
};

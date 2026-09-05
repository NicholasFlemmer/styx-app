import { colors, terminalAnsi } from '@styx/tokens';
import { describe, expect, it } from 'vitest';
import { sgrColor, staticLines, xtermTheme } from './terminal-theme';

describe('terminal theme', () => {
  it.each(['dark', 'light'] as const)('maps %s tokens onto the xterm theme', (theme) => {
    const t = xtermTheme(theme);
    expect(t.background).toBe(colors[theme].term);
    expect(t.foreground).toBe(colors[theme].termtx);
    expect(t.cursor).toBe(colors[theme].termtx);
    expect(t.selectionBackground).toBe(colors[theme].ac);
    expect(t.selectionForeground).toBe(colors[theme].acx);
    for (const [name, value] of Object.entries(terminalAnsi[theme])) {
      expect(t[name as keyof typeof t]).toBe(value);
    }
  });

  it('emits truecolor SGR sequences from hex tokens', () => {
    expect(sgrColor('#858a81')).toBe('[38;2;133;138;129m');
  });

  it('renders the prototype lines with the timing in --mu', () => {
    const text = staticLines('dark');
    expect(text.startsWith('$ npx vitest\r\n✓ 42 passed ')).toBe(true);
    expect(text).toContain(`${sgrColor(colors.dark.mu)}(1.2s)[0m`);
    expect(text.endsWith('\r\n$ ')).toBe(true);
  });
});

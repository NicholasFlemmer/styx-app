import { colors, terminalAnsi, type Theme } from '@styx/tokens';

/** Structural copy of xterm's `ITheme` so this module stays free of the xterm import (jsdom-safe). */
export interface XtermTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
  selectionInactiveBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** `--term` / `--termtx` surface, accent selection, ANSI palette from `terminalAnsi` (packages/tokens). */
export const xtermTheme = (theme: Theme): XtermTheme => {
  const c = colors[theme];
  return {
    background: c.term,
    foreground: c.termtx,
    cursor: c.termtx,
    cursorAccent: c.term,
    selectionBackground: c.ac,
    selectionForeground: c.acx,
    selectionInactiveBackground: c.ln,
    ...terminalAnsi[theme],
  };
};

/** SGR truecolor sequence for a token colour (`#rrggbb`), used by the static fallback lines. */
export const sgrColor = (hex: string): string => {
  const v = hex.replace('#', '');
  const r = Number.parseInt(v.slice(0, 2), 16);
  const g = Number.parseInt(v.slice(2, 4), 16);
  const b = Number.parseInt(v.slice(4, 6), 16);
  return `[38;2;${r};${g};${b}m`;
};

export const SGR_RESET = '[0m';

/** Prototype terminal lines: `$ npx vitest` / `✓ 42 passed (1.2s)` (timing in `--mu`) / `$ ▮`. */
export const staticLines = (theme: Theme): string =>
  ['$ npx vitest', `✓ 42 passed ${sgrColor(colors[theme].mu)}(1.2s)${SGR_RESET}`, '$ '].join('\r\n');

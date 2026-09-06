import { isReserved, parseChord, RESERVED, type SessionId, type WorktreeId } from '@styx/core';
import { matchesEvent } from '@styx/core';
import type { Theme } from '@styx/tokens';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { bridge, env, platform } from '../../state/bridge';
import { STATIC_CARET, staticLines, xtermTheme } from './terminal-theme';

const RESERVED_CHORDS = RESERVED.map(parseChord);

/** True for RESERVED chords (Mod+K, Mod+1–4, …) that must reach the app registry instead of xterm. */
export const isReservedKey = (e: KeyboardEvent): boolean => {
  const p = platform();
  return RESERVED_CHORDS.some((c) => matchesEvent(c, e, p) && isReserved(c));
};

export interface TerminalEntry {
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  /** `terminal.spawn` id once a user pty is attached; null while static/fallback. */
  terminalId: string | null;
  webgl: WebglAddon | null;
  offData: () => void;
  offExit: () => void;
  resizeTimer: number | null;
  attached: boolean;
}

const entries = new Map<string, TerminalEntry>();
const RESIZE_DEBOUNCE_MS = 50;

const currentTheme = (): Theme => (document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark');

/** Spec §9 "reduced motion respected": no blinking caret when the OS asks for less motion. */
const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

let themeWatched = false;
const watchTheme = (): void => {
  if (themeWatched || typeof MutationObserver !== 'function') return;
  themeWatched = true;
  new MutationObserver(() => {
    const theme = xtermTheme(currentTheme());
    for (const e of entries.values()) e.term.options.theme = theme;
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
};

const tryWebgl = (entry: TerminalEntry): void => {
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      // Context lost (GPU reset, backgrounded window): drop back to the DOM renderer.
      webgl.dispose();
      entry.webgl = null;
    });
    entry.term.loadAddon(webgl);
    entry.webgl = webgl;
  } catch {
    entry.webgl = null;
  }
};

/** Fits inside a frame and only when the host is laid out (plan §8: `clientHeight > 0` guard). */
export const fitTerminal = (entry: TerminalEntry): void => {
  requestAnimationFrame(() => {
    if (!entry.attached || entry.host.clientHeight <= 0 || entry.host.clientWidth <= 0) return;
    try {
      entry.fit.fit();
    } catch {
      /* not measurable yet */
    }
  });
};

/** Prototype lines with a drawn caret (xterm only paints its own cursor once the terminal was focused). */
const writeStatic = (entry: TerminalEntry): void => {
  entry.term.options.cursorInactiveStyle = 'none';
  entry.term.options.cursorStyle = 'block';
  entry.term.write(staticLines(currentTheme()) + STATIC_CARET);
};

const attachPty = async (entry: TerminalEntry, worktreeId: WorktreeId): Promise<void> => {
  const api = bridge();
  const pty = api?.pty;
  // e2e / renderer-only dev: the prototype's static lines, deterministic and prompt-free.
  if (api?.command === undefined || pty === undefined || env().e2e === true) {
    writeStatic(entry);
    return;
  }
  let terminalId: string | null = null;
  try {
    const r = await api.command('terminal.spawn', { worktreeId });
    if (r.ok) terminalId = r.value.terminalId;
  } catch {
    terminalId = null;
  }
  if (terminalId === null) {
    writeStatic(entry);
    return;
  }
  entry.terminalId = terminalId;
  entry.offData = pty.onData((id, data) => {
    if (id === terminalId) entry.term.write(data);
  });
  entry.offExit = pty.onExit((id) => {
    if (id === terminalId) entry.terminalId = null;
  });
  entry.term.onData((data) => {
    if (entry.terminalId !== null) pty.write(entry.terminalId, data);
  });
  entry.term.onResize(({ cols, rows }) => {
    if (entry.resizeTimer !== null) window.clearTimeout(entry.resizeTimer);
    entry.resizeTimer = window.setTimeout(() => {
      entry.resizeTimer = null;
      if (entry.terminalId !== null) pty.resize(entry.terminalId, cols, rows);
    }, RESIZE_DEBOUNCE_MS);
  });
  pty.resize(terminalId, entry.term.cols, entry.term.rows);
};

export interface TerminalOptions {
  screenReader: boolean;
}

/**
 * One `Terminal` per session, created on first use and kept alive across tab switches (the host element is
 * re-parented, never disposed). JetBrains Mono 12/1.6, tokens theme, WebGL with DOM fallback.
 */
/** `ownerKey`: the session id, or the worktree id for the sessionless terminal of a freshly added project. */
export const getTerminal = (
  ownerKey: SessionId | WorktreeId,
  worktreeId: WorktreeId,
  opts: TerminalOptions,
): TerminalEntry => {
  const existing = entries.get(ownerKey);
  if (existing !== undefined) return existing;
  watchTheme();
  const host = document.createElement('div');
  host.style.width = '100%';
  host.style.height = '100%';
  const term = new Terminal({
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: 12,
    // xterm scales the measured glyph box (~16px for JetBrains Mono 12), not the font size: 1.2 ≈ the prototype's 1.6 × 12px.
    lineHeight: 1.2,
    theme: xtermTheme(currentTheme()),
    cursorStyle: 'block',
    cursorInactiveStyle: 'block',
    cursorBlink: env().e2e !== true && !reducedMotion(),
    scrollback: 5000,
    allowTransparency: false,
    minimumContrastRatio: 1,
    screenReaderMode: opts.screenReader,
    drawBoldTextInBrightColors: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.attachCustomKeyEventHandler((e) => !isReservedKey(e));
  const entry: TerminalEntry = {
    term,
    fit,
    host,
    terminalId: null,
    webgl: null,
    offData: () => {},
    offExit: () => {},
    resizeTimer: null,
    attached: false,
  };
  entries.set(ownerKey, entry);
  term.open(host);
  tryWebgl(entry);
  void attachPty(entry, worktreeId);
  return entry;
};

/** Re-parents the persistent host into `parent` and fits once laid out. */
export const attachTerminal = (entry: TerminalEntry, parent: HTMLElement): void => {
  parent.append(entry.host);
  entry.attached = true;
  fitTerminal(entry);
};

export const detachTerminal = (entry: TerminalEntry): void => {
  entry.attached = false;
  entry.host.remove();
};

export const setTerminalScreenReader = (entry: TerminalEntry, on: boolean): void => {
  entry.term.options.screenReaderMode = on;
};

/** Disposes a session's terminal (session archived / app teardown). */
export const disposeTerminal = (ownerKey: SessionId | WorktreeId): void => {
  const e = entries.get(ownerKey);
  if (e === undefined) return;
  e.offData();
  e.offExit();
  e.webgl?.dispose();
  e.term.dispose();
  e.host.remove();
  entries.delete(ownerKey);
  const api = bridge();
  if (e.terminalId !== null && api?.command !== undefined) {
    void api.command('terminal.kill', { terminalId: e.terminalId });
  }
};

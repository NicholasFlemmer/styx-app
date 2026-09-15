import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { bridge, env } from '../../state/bridge';
import { isReservedKey, type TerminalEntry } from '../terminal/terminal-registry';
import { xtermTheme } from '../terminal/terminal-theme';

const currentTheme = () => (document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark');

/** Spec §9 "reduced motion respected": no blinking caret when the OS asks for less motion. */
const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * An xterm bound to a pty main already spawned (`target.connect.cliLogin` → `terminalId`) over the `pty` channel.
 * Same recipe as the session terminals (JetBrains Mono 12, tokens theme, DOM renderer — the modal is short-lived,
 * so no WebGL); disposed with the modal, and the pty is left to main (`connect.cliLogin` reports its exit).
 */
export const createLoginTerminal = (
  terminalId: string,
  opts: { screenReader?: boolean } = {},
): TerminalEntry => {
  const host = document.createElement('div');
  host.style.width = '100%';
  host.style.height = '100%';
  const term = new Terminal({
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: 12,
    lineHeight: 1.2,
    theme: xtermTheme(currentTheme()),
    cursorStyle: 'block',
    cursorInactiveStyle: 'block',
    cursorBlink: env().e2e !== true && !reducedMotion(),
    screenReaderMode: opts.screenReader === true,
    scrollback: 1000,
    allowTransparency: false,
    minimumContrastRatio: 1,
    drawBoldTextInBrightColors: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.attachCustomKeyEventHandler((e) => !isReservedKey(e));
  const entry: TerminalEntry = {
    term,
    fit,
    host,
    terminalId,
    webgl: null,
    offData: () => {},
    offExit: () => {},
    resizeTimer: null,
    attached: false,
  };
  term.open(host);
  const pty = bridge()?.pty;
  if (pty !== undefined) {
    entry.offData = pty.onData((id, data) => {
      if (id === terminalId) term.write(data);
    });
    entry.offExit = pty.onExit((id) => {
      if (id === terminalId) entry.terminalId = null;
    });
    term.onData((data) => {
      if (entry.terminalId !== null) pty.write(entry.terminalId, data);
    });
    term.onResize(({ cols, rows }) => {
      if (entry.terminalId !== null) pty.resize(entry.terminalId, cols, rows);
    });
    pty.resize(terminalId, term.cols, term.rows);
  }
  return entry;
};

export const disposeLoginTerminal = (entry: TerminalEntry): void => {
  entry.offData();
  entry.offExit();
  if (entry.resizeTimer !== null) window.clearTimeout(entry.resizeTimer);
  entry.term.dispose();
  entry.host.remove();
};

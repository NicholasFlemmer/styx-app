import { copy, fill, type SessionId, type WorktreeId } from '@styx/core';
import { sizes } from '@styx/tokens';
import { useCallback, useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { command } from '../../state/commands';
import { useUi } from '../../state/hooks';
import {
  attachTerminal,
  detachTerminal,
  fitTerminal,
  getTerminal,
  setTerminalScreenReader,
  type TerminalEntry,
} from './terminal-registry';
import s from './TerminalPane.module.css';

export const TERMINAL_MIN = 80;
export const TERMINAL_MAX_RATIO = 0.6;
/** Header strip height when collapsed (padding + 9px label + gap). */
export const TERMINAL_COLLAPSED = 24;
const PANE_KEY = 'terminal';
/** ↑ / ↓ on the focused handle. */
export const KEY_STEP = 16;
const LAST_KEY = 'terminalLast';

export const clampTerminalHeight = (h: number, columnHeight: number): number =>
  Math.max(TERMINAL_MIN, Math.min(h, Math.max(TERMINAL_MIN, Math.floor(columnHeight * TERMINAL_MAX_RATIO))));

export interface TerminalPaneProps {
  /** The chat's active session; null before the first spawn (the terminal then belongs to the worktree). */
  sessionId: SessionId | null;
  worktreeId: WorktreeId;
  branch: string;
  screenReader: boolean;
  /** Height of the editor column, for the 60 % cap. */
  columnHeight: () => number;
}

/**
 * Terminal pane (spec §4.1: 130px, drag-resizable, collapsible): `Terminal, {branch}` label, one xterm per
 * session kept alive across tab switches, 6px drag handle on the top edge, double-click collapses.
 */
export function TerminalPane({
  sessionId,
  worktreeId,
  branch,
  screenReader,
  columnHeight,
}: TerminalPaneProps) {
  const host = useRef<HTMLDivElement>(null);
  const entry = useRef<TerminalEntry | null>(null);
  const height = useUi((u) => u.paneSizes[PANE_KEY] ?? sizes.terminal);
  const last = useUi((u) => u.paneSizes[LAST_KEY] ?? sizes.terminal);
  const setPaneSize = useUi((u) => u.setPaneSize);
  const collapsed = height <= TERMINAL_COLLAPSED;

  useEffect(() => {
    const el = host.current;
    if (el === null) return;
    const e = getTerminal(sessionId ?? worktreeId, worktreeId, { screenReader });
    entry.current = e;
    attachTerminal(e, el);
    return () => {
      detachTerminal(e);
      entry.current = null;
    };
    // screenReader is applied below without re-attaching.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, worktreeId]);

  useEffect(() => {
    if (entry.current !== null) setTerminalScreenReader(entry.current, screenReader);
  }, [screenReader]);

  useEffect(() => {
    if (entry.current !== null && !collapsed) fitTerminal(entry.current);
  }, [height, collapsed]);

  const persist = useCallback(
    (h: number) => {
      setPaneSize(PANE_KEY, h);
      if (h > TERMINAL_COLLAPSED) setPaneSize(LAST_KEY, h);
      void command('ui.persist', { paneSizes: { [PANE_KEY]: h } });
    },
    [setPaneSize],
  );

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const startY = e.clientY;
    const startH = collapsed ? TERMINAL_COLLAPSED : height;
    let next = startH;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: globalThis.PointerEvent) => {
      next = clampTerminalHeight(startH + (startY - ev.clientY), columnHeight());
      setPaneSize(PANE_KEY, next);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      persist(next);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };

  const toggle = () => persist(collapsed ? clampTerminalHeight(last, columnHeight()) : TERMINAL_COLLAPSED);

  /** Keyboard parity for the drag handle (spec §9): ↑ / ↓ resize by 16px, ⏎ toggles collapse. */
  const onHandleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      toggle();
      return;
    }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const base = collapsed ? TERMINAL_COLLAPSED : height;
    persist(clampTerminalHeight(base + (e.key === 'ArrowUp' ? KEY_STEP : -KEY_STEP), columnHeight()));
  };

  return (
    <div
      className={s['pane']}
      style={{ height }}
      data-keyscope="terminal"
      data-terminal="true"
      data-collapsed={collapsed ? 'true' : undefined}
    >
      <div
        className={s['handle']}
        role="separator"
        aria-orientation="horizontal"
        aria-label={copy.workspace.terminal.split(' ·')[0]}
        aria-valuenow={height}
        aria-valuemin={TERMINAL_COLLAPSED}
        tabIndex={0}
        onKeyDown={onHandleKeyDown}
        onPointerDown={onPointerDown}
        onDoubleClick={toggle}
      />
      <div className={s['label']} onDoubleClick={toggle}>
        {fill(copy.workspace.terminal, { branch })}
      </div>
      <div ref={host} className={s['host']} hidden={collapsed} />
    </div>
  );
}

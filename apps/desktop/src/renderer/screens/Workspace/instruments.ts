import { copy, instrumentOrderOf, type Instrument } from '@styx/core';

/** Which instrument the centre shows (ADR-0027 §2); persisted alongside the pane sizes. */
export const WORKSPACE_MODE_KEY = 'workspace-mode';

/** How each instrument is stored in `paneSizes` (0 and 1 kept from Code / Design, the old Preview). */
export const INSTRUMENT_CODE: Record<Instrument, number> = {
  code: 0,
  design: 1,
  changes: 2,
  terminal: 3,
  tasks: 4,
  canvas: 5,
};

export const INSTRUMENT_LABEL: Record<Instrument, string> = {
  tasks: copy.chat.instruments.tasks,
  canvas: copy.chat.instruments.canvas,
  design: copy.chat.instruments.preview,
  changes: copy.chat.instruments.changes,
  code: copy.chat.instruments.code,
  terminal: copy.chat.instruments.terminal,
};

export const instrumentOf = (n: number | undefined, fallback: Instrument): Instrument =>
  (Object.entries(INSTRUMENT_CODE) as [Instrument, number][]).find(([, c]) => c === n)?.[0] ?? fallback;

/**
 * Until the person picks one: their first tab when they have arranged the tabs, otherwise Preview for a project that
 * knows how to run its app and Tasks for any other (#138, #140).
 */
export const defaultInstrument = (order: readonly string[], runnable: boolean): Instrument => {
  if (order.length > 0) return instrumentOrderOf(order)[0] ?? 'tasks';
  return runnable ? 'design' : 'tasks';
};

/** The order after moving `key` to `to` (an index in the current order). */
export const moveInstrument = (order: readonly Instrument[], key: Instrument, to: number): Instrument[] => {
  const rest = order.filter((k) => k !== key);
  const at = Math.max(0, Math.min(rest.length, to));
  return [...rest.slice(0, at), key, ...rest.slice(at)];
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Remaining time: "59m", "1h 10m", "1h", "2d"; floors at "0m". */
export const formatCountdown = (ms: number): string => {
  if (ms < MINUTE) return '0m';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    const m = Math.floor((ms - h * HOUR) / MINUTE);
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }
  return `${Math.floor(ms / DAY)}d`;
};

/** Age since `from`: "now", "2m", "1h", "1d"; "—" when unknown. */
export const formatAge = (from: number | null, now: number): string => {
  if (from === null) return '—';
  const ms = Math.max(0, now - from);
  if (ms < MINUTE) return 'now';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d`;
};

/** "09:41" wall-clock label for audit rows; `utcOffsetMinutes` keeps this pure (main passes the zone). */
export const formatClock = (ms: number, utcOffsetMinutes = 0): string => {
  const shifted = new Date(ms + utcOffsetMinutes * MINUTE);
  const h = String(shifted.getUTCHours()).padStart(2, '0');
  const m = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
};

/** Counters are zero-padded to 2 digits (spec §10 tone); nothing else is. */
export const padCount = (n: number): string => String(n).padStart(2, '0');

/** "+142 −38 · 3 files" */
export const formatChanges = (changes: { added: number; removed: number; files: number }): string =>
  `+${changes.added} −${changes.removed} · ${changes.files} ${changes.files === 1 ? 'file' : 'files'}`;

export const joinScopes = (scopes: readonly string[], sep = '+'): string => scopes.join(sep);

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { UsageEvent } from '@styx/core';

/**
 * `<userData>/running` (#125): written at launch, rewritten when a quit starts, removed when the quit finishes. One
 * still there at the next launch means the previous run never finished quitting, and what it says tells how far
 * it got: still running (a crash, a force quit, power lost) or already quitting (a quit that hung and was killed).
 */
export const runningMarker = (now: number): string => `running ${now}`;
export const quittingMarker = (now: number): string => `quitting ${now}`;

/** When the run that left `text` started; `null` if unreadable. Markers before this file held the bare number. */
const startedAt = (text: string): number | null => {
  const m = /^(?:running )?(\d+)\s*$/.exec(text.trim());
  return m?.[1] === undefined ? null : Number(m[1]);
};

/**
 * The counts for how the previous run ended, from the marker it left (`null` when there was none, a clean quit)
 * and the modification times of the crash dumps on disk. A dump written after that run started means its main
 * process crashed, which is the one crash nothing else counts.
 */
export function previousRunEnding(text: string | null, dumpTimes: readonly number[]): UsageEvent[] {
  if (text === null) return [];
  if (text.startsWith('quitting')) return ['app.ended-while-quitting'];
  const since = startedAt(text);
  const crashed = since !== null && dumpTimes.some((t) => t >= since);
  return crashed ? ['app.ended-unexpectedly', 'app.crashed.main'] : ['app.ended-unexpectedly'];
}

/** Modification times of the `.dmp` files Crashpad keeps under `dir` (two levels: `completed/`, `reports/`, …). */
export function crashDumpTimes(dir: string): number[] {
  const times: number[] = [];
  const walk = (d: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(d, name);
      try {
        const st = statSync(p);
        if (st.isDirectory() && depth > 0) walk(p, depth - 1);
        else if (st.isFile() && name.endsWith('.dmp')) times.push(st.mtimeMs);
      } catch {
        // A file Crashpad is still writing or just removed: not worth failing a launch over.
      }
    }
  };
  walk(dir, 2);
  return times;
}

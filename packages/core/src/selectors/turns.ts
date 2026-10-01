import { copy, fill } from '../copy';
import type { SessionId } from '../ids';
import type { ReadModel } from '../read-model';

/**
 * Turns in plain words (ADR-0027 §3 / §4): what each tool call did, said the way a person would, and what a lane
 * holds so far. The raw tool rows stay one click away; these are what the chat shows first.
 */

const STEP_HINT_MAX = 56;

const clip = (text: string, max = STEP_HINT_MAX): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};

/** `src/pages/Settings.tsx` → `Settings.tsx`; a URL → its host. */
const shortTarget = (hint: string): string => {
  const h = hint.trim();
  try {
    if (/^https?:\/\//.test(h)) return new URL(h).host;
  } catch {
    // not a URL after all
  }
  const parts = h.split(/[\\/]/).filter((p) => p !== '');
  return clip(parts.at(-1) ?? h);
};

/**
 * One tool call as a step ("Read Settings.tsx", "Ran pnpm test", "Searched for “usePref”"). Every runner already
 * normalises tool names to these (ACP and Codex map onto Claude's), so the table is small. Unknown tools keep
 * their name.
 */
export const stepOf = (tool: string, hint: string): string => {
  const h = hint.trim();
  const steps = copy.chat.steps;
  switch (tool) {
    case 'Read':
      return h === '' ? steps.readAny : fill(steps.read, { target: shortTarget(h) });
    case 'Write':
      return h === '' ? steps.writeAny : fill(steps.write, { target: shortTarget(h) });
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return h === '' ? steps.editAny : fill(steps.edit, { target: shortTarget(h) });
    case 'Bash':
      return h === '' ? steps.runAny : fill(steps.run, { command: clip(h) });
    case 'Grep':
      return h === '' ? steps.searchAny : fill(steps.search, { pattern: clip(h, 40) });
    case 'Glob':
      return h === '' ? steps.searchAny : fill(steps.find, { pattern: clip(h, 40) });
    case 'WebFetch':
      return h === '' ? steps.fetchAny : fill(steps.fetch, { target: shortTarget(h) });
    case 'WebSearch':
      return h === '' ? steps.webAny : fill(steps.web, { query: clip(h, 40) });
    case 'Task':
      return steps.helper;
    case 'TodoWrite':
      return steps.plan;
    default:
      return h === '' ? tool : `${tool} ${clip(h)}`;
  }
};

/** "12 steps" / "1 step", with how many failed. */
export const stepsLabel = (total: number, failed: number): string => {
  const base = total === 1 ? copy.chat.steps.countOne : fill(copy.chat.steps.count, { n: total });
  return failed === 0 ? base : `${base}, ${fill(copy.chat.steps.failed, { n: failed })}`;
};

/** "Done in 40 s" / "Done in 4 min" / "Done in 1 h 12 min", from a turn's start and settle. */
export const turnDoneLabel = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return fill(copy.chat.turn.doneSeconds, { n: s });
  const m = Math.round(s / 60);
  if (m < 60) return fill(copy.chat.turn.doneMinutes, { n: m });
  return fill(copy.chat.turn.doneHours, { h: Math.floor(m / 60), m: m % 60 });
};

/** "3 files, +42 −3" for a turn's change. */
export const changeLabel = (c: { files: number; added: number; removed: number }): string =>
  fill(c.files === 1 ? copy.chat.turn.changeOne : copy.chat.turn.change, {
    files: c.files,
    added: c.added,
    removed: c.removed,
  });

export interface LaneSummary {
  /** Turns with changes that are still in the lane. */
  kept: number;
  /** Turns with changes the person undid. */
  undone: number;
  /** The lane's change against its base, as the last scan counted it. */
  files: number;
  added: number;
  removed: number;
}

/** What a lane holds so far: its kept and undone turns, and its files against the base. */
export const laneSummary = (model: ReadModel, sessionId: SessionId): LaneSummary | null => {
  const session = model.sessions.byId[sessionId];
  if (session === undefined) return null;
  let kept = 0;
  let undone = 0;
  for (const c of model.checkpoints[sessionId] ?? []) {
    if (c.ref === null || c.files === 0) continue;
    if (c.revertedAt === null) kept += 1;
    else undone += 1;
  }
  const w = model.worktrees.byId[session.worktreeId];
  return {
    kept,
    undone,
    files: w?.changes.files ?? 0,
    added: w?.changes.added ?? 0,
    removed: w?.changes.removed ?? 0,
  };
};

/** "3 turns kept, 7 files changed" · "1 turn kept, 1 file changed" · "No changes yet". */
export const laneSummaryLabel = (sum: LaneSummary): string => {
  const l = copy.chat.lane;
  if (sum.files === 0 && sum.kept === 0) return l.noChanges;
  const files = sum.files === 1 ? l.filesOne : fill(l.files, { n: sum.files });
  if (sum.kept === 0) return files;
  const turns = sum.kept === 1 ? l.keptOne : fill(l.kept, { n: sum.kept });
  return `${turns}, ${files}`;
};

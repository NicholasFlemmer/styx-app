import { copy, fill, formatAge, type AgentChange, type HunkId } from '@styx/core';

/** One decorated (agent-added) line of the open file. `label` is set on the first added line of each hunk. */
export interface HunkLineDecoration {
  hunkId: HunkId;
  /** 1-based line in the current model. */
  line: number;
  /** "Claude · 2m" (rendered uppercase by CSS) or null. */
  label: string | null;
}

/** Strips the unified-diff prefix from a patch line. */
const bodyOf = (line: string): string => line.slice(1);

/** The hunk body (lines after the `@@` header), without the trailing empty element a final newline produces. */
export const hunkBody = (patch: string): string[] => {
  const lines = patch.split('\n');
  const at = lines.findIndex((l) => l.startsWith('@@'));
  const body = lines.slice(at + 1);
  if (body[body.length - 1] === '') body.pop();
  return body.filter((l) => !l.startsWith('\\'));
};

/** New-side lines of a hunk (context + added), and which of them were added. */
export const newSideOf = (patch: string): { text: string; added: boolean }[] =>
  hunkBody(patch)
    .filter((l) => !l.startsWith('-'))
    .map((l) => ({ text: bodyOf(l), added: l.startsWith('+') }));

/** Whether a hunk describes `path` (hunks carry repo-relative files; the tree may nest them under a dir). */
export const hunkMatchesFile = (change: Pick<AgentChange, 'file'>, path: string): boolean =>
  change.file === path || path.endsWith(`/${change.file}`) || change.file.endsWith(`/${path}`);

/**
 * Locates a hunk's new side in the current model text: the occurrence nearest to `newStart` wins, so line
 * numbers survive edits above the hunk. Falls back to `newStart` arithmetic when the text has drifted.
 * Returns the 1-based line of the first new-side line.
 */
export const locateHunk = (
  change: Pick<AgentChange, 'patch' | 'newStart'>,
  modelLines: readonly string[],
): number => {
  const side = newSideOf(change.patch);
  const fallback = Math.max(1, change.newStart);
  if (side.length === 0 || modelLines.length === 0) return fallback;
  let best: number | null = null;
  for (let start = 0; start + side.length <= modelLines.length; start += 1) {
    let ok = true;
    for (let i = 0; i < side.length; i += 1) {
      if (modelLines[start + i] !== side[i]?.text) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const line = start + 1;
    if (best === null || Math.abs(line - fallback) < Math.abs(best - fallback)) best = line;
  }
  return best ?? fallback;
};

/** 1-based model lines added by a hunk. */
export const addedLinesOf = (
  change: Pick<AgentChange, 'patch' | 'newStart'>,
  modelLines: readonly string[],
): number[] => {
  const start = locateHunk(change, modelLines);
  const out: number[] = [];
  newSideOf(change.patch).forEach((l, i) => {
    if (l.added) out.push(start + i);
  });
  return out;
};

export interface HunkDecorationInput {
  /** All agent changes of the worktree. */
  changes: readonly AgentChange[];
  /** The open file (tree path). */
  path: string;
  /** Current model text, split into lines. */
  modelLines: readonly string[];
  /** Agent label per session id ("Claude"). */
  agentOf: (sessionId: AgentChange['sessionId']) => string;
  now: number;
}

/**
 * Pending hunks of `path` → one decoration per added line; the first added line of each hunk carries the
 * `{agent} · {age}` label (spec §4.1). Pure; the Monaco binding turns these into `IModelDeltaDecoration`s.
 */
export const buildHunkDecorations = ({
  changes,
  path,
  modelLines,
  agentOf,
  now,
}: HunkDecorationInput): HunkLineDecoration[] => {
  const out: HunkLineDecoration[] = [];
  for (const change of changes) {
    if (change.status !== 'pending' || !hunkMatchesFile(change, path)) continue;
    const lines = addedLinesOf(change, modelLines);
    const label = fill(copy.diff.hunkLabel, {
      agent: agentOf(change.sessionId),
      age: formatAge(change.firstSeenAt, now),
    });
    lines.forEach((line, i) => out.push({ hunkId: change.id, line, label: i === 0 ? label : null }));
  }
  return out.sort((a, b) => a.line - b.line);
};

/** Pending hunks of a worktree across every session, in model order. */
export const pendingHunksOf = (
  hunks: Readonly<Record<string, readonly AgentChange[]>>,
  worktreeId: AgentChange['worktreeId'],
): AgentChange[] =>
  Object.values(hunks)
    .flat()
    .filter((h) => h.worktreeId === worktreeId && h.status === 'pending');

/** "3 hunks from Claude · 42 tests pass" — the note suffix only when the session note mentions passing tests. */
export const hunkBarLabel = (n: number, agent: string, note: string | null): string => {
  const tests = note === null ? null : /(\d+) tests? pass/.exec(note);
  const template = tests === null ? copy.diff.hunkBar.replace(' · {note}', '') : copy.diff.hunkBar;
  return fill(template, { n, agent, note: tests === null ? '' : `${tests[1]} tests pass` });
};

import {
  agentLabel,
  branchOf,
  copy,
  fill,
  formatChord,
  type AgentChange,
  type ChangeStatus,
  type HunkId,
  type Platform,
  type ProjectId,
  type ReadModel,
  type SessionId,
} from '@styx/core';
import { shortcuts } from '@styx/tokens';
import { changeHeader, changeRows, type DiffRow } from '../../features/diff';

/** One reviewable hunk (prototype `hunks`): stale ones are gone from the worktree and never listed. */
export interface ReviewHunk {
  id: HunkId;
  file: string;
  range: string;
  status: Exclude<ChangeStatus, 'stale'>;
  rows: DiffRow[];
}

export type ReviewCounts = { accepted: number; rejected: number; pending: number };

export interface Review {
  sessionId: SessionId | null;
  agent: string;
  branch: string;
  hunks: ReviewHunk[];
  files: { file: string; added: number }[];
  counts: ReviewCounts;
  /** `Claude · fix/checkout · 0 accepted · 0 rejected · 3 pending` */
  meta: string;
}

const live = (changes: readonly AgentChange[] | undefined): AgentChange[] =>
  (changes ?? []).filter((c) => c.status !== 'stale');

/** The session under review: the active one when it has hunks, else the project's first session with hunks. */
export const reviewSessionId = (
  model: ReadModel,
  projectId: ProjectId | null,
  activeSessionId: SessionId | null,
): SessionId | null => {
  if (activeSessionId !== null && live(model.hunks[activeSessionId]).length > 0) return activeSessionId;
  for (const [id, changes] of Object.entries(model.hunks)) {
    const session = model.sessions.byId[id];
    if (session === undefined) continue;
    if (projectId !== null && session.projectId !== projectId) continue;
    if (live(changes).length > 0) return session.id;
  }
  return activeSessionId;
};

export const reviewHunks = (model: ReadModel, sessionId: SessionId): ReviewHunk[] =>
  live(model.hunks[sessionId]).map((c) => ({
    id: c.id,
    file: c.file,
    range: changeHeader(c),
    status: c.status === 'stale' ? 'pending' : c.status,
    rows: changeRows(c),
  }));

/** Files in first-seen order with their added-line counts (`+N`). */
export const fileCounts = (hunks: readonly ReviewHunk[]): { file: string; added: number }[] => {
  const out: { file: string; added: number }[] = [];
  for (const h of hunks) {
    const added = h.rows.filter((r) => r.kind === 'add').length;
    const entry = out.find((f) => f.file === h.file);
    if (entry === undefined) out.push({ file: h.file, added });
    else entry.added += added;
  }
  return out;
};

export const reviewCounts = (hunks: readonly ReviewHunk[]): ReviewCounts => ({
  accepted: hunks.filter((h) => h.status === 'accepted').length,
  rejected: hunks.filter((h) => h.status === 'rejected').length,
  pending: hunks.filter((h) => h.status === 'pending').length,
});

export const reviewOf = (
  model: ReadModel,
  projectId: ProjectId | null,
  activeSessionId: SessionId | null,
): Review => {
  const sessionId = reviewSessionId(model, projectId, activeSessionId);
  const session = sessionId === null ? undefined : model.sessions.byId[sessionId];
  const hunks = sessionId === null ? [] : reviewHunks(model, sessionId);
  const counts = reviewCounts(hunks);
  const agent = session === undefined ? copy.general.none : agentLabel(session);
  const branch = session === undefined ? copy.general.none : branchOf(model, session);
  return {
    sessionId,
    agent,
    branch,
    hunks,
    files: fileCounts(hunks),
    counts,
    meta: fill(copy.diff.meta, { agent, branch, summary: fill(copy.diff.summary, counts) }),
  };
};

/** Modifier glyph for the Keys legend: `⌘` on macOS, `Ctrl` on Windows (from core `formatChord`). */
export const modLabel = (platform: Platform): string => {
  const full = formatChord(shortcuts.diffDone, platform);
  const key = formatChord('Enter', platform);
  return full.endsWith(key) ? full.slice(0, full.length - key.length).replace(/\+$/, '') : full;
};

export const clampFocus = (index: number, count: number): number =>
  count === 0 ? 0 : Math.min(Math.max(0, index), count - 1);

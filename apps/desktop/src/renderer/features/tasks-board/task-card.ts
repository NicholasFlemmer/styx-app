import { laneSummary, laneSummaryLabel, stepOf, type ReadModel, type SessionId } from '@styx/core';

/** How many of the lane's latest steps a card lists. */
export const CARD_STEPS = 3;

export interface TaskCardStep {
  key: string;
  label: string;
  status: 'running' | 'ok' | 'error';
}

export interface TaskCard {
  /** The lane's latest steps in plain words, oldest first; the last may be running. */
  steps: TaskCardStep[];
  /** The agent's latest status line ("Requesting Supabase prod · read + write"), when it has one. */
  note: string | null;
  /** What the lane holds so far ("3 turns kept, 7 files changed"). */
  summary: string;
}

/**
 * A task's summary for the Tasks board (#138): its latest steps since the person last spoke, its status line and
 * what it holds. Read from the mirrored transcript; no I/O.
 */
export const taskCard = (model: ReadModel, sessionId: SessionId): TaskCard => {
  const rows = [...(model.transcripts[sessionId] ?? [])].sort((a, b) => a.seq - b.seq);
  const lastUser = rows.map((m) => m.payload.kind).lastIndexOf('user');
  const steps: TaskCardStep[] = [];
  for (const m of rows.slice(lastUser + 1))
    if (m.payload.kind === 'tool')
      steps.push({ key: m.id, label: stepOf(m.payload.tool, m.payload.hint), status: m.payload.status });
  const note = model.sessions.byId[sessionId]?.note?.trim() ?? '';
  const sum = laneSummary(model, sessionId);
  return {
    steps: steps.slice(-CARD_STEPS),
    note: note === '' ? null : note,
    summary: sum === null ? '' : laneSummaryLabel(sum),
  };
};

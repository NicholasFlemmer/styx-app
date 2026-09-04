import type { AskId, ProjectId, SessionId } from '../ids';
import { copy } from '../copy';
import type { AskKind, Session, SessionState } from '../model/session';
import type { ReadModel } from '../read-model';
import { agentLabel, branchOf, headAskOf, liveSessions, projectNameOf } from './common';
import { formatAge, padCount } from './format';

export type BoardColumnKey = 'needs-you' | 'working' | 'done';

export interface BoardCard {
  sessionId: SessionId;
  projectId: ProjectId;
  agent: string;
  age: string;
  project: string;
  branch: string;
  note: string;
  state: SessionState;
  needs: boolean;
  paused: boolean;
  cta: string;
  askId: AskId | null;
  askKind: AskKind | null;
}

export interface BoardColumn {
  key: BoardColumnKey;
  label: string;
  /** Accent-filled header (Needs you). */
  hot: boolean;
  /** Shows the dashed "+ Spawn agent" affordance (Working). */
  spawn: boolean;
  /** Zero-padded count. */
  count: string;
  items: BoardCard[];
  empty: boolean;
  emptyText: string;
}

const ctaFor = (session: Session, askKind: AskKind | null): string => {
  if (session.state === 'done') return copy.board.actions.archive;
  if (session.state !== 'needs-you') return copy.board.actions.open;
  if (askKind === 'grant') return copy.board.actions.reviewGrant;
  if (askKind === 'plan') return copy.board.actions.reviewPlan;
  return copy.approvals.review;
};

export const boardCard = (model: ReadModel, session: Session, now: number): BoardCard => {
  const ask = headAskOf(model, session.id);
  const askKind = ask?.kind ?? null;
  return {
    sessionId: session.id,
    projectId: session.projectId,
    agent: agentLabel(session),
    age: formatAge(session.lastActivityAt, now),
    project: projectNameOf(model, session.projectId),
    branch: branchOf(model, session),
    note: session.state === 'paused' ? copy.board.states.paused : (session.note ?? ''),
    state: session.state,
    needs: session.state === 'needs-you',
    paused: session.state === 'paused',
    cta: ctaFor(session, askKind),
    askId: ask?.id ?? null,
    askKind,
  };
};

const COLUMN_STATES: Record<BoardColumnKey, readonly SessionState[]> = {
  'needs-you': ['needs-you'],
  working: ['working', 'idle', 'paused'],
  done: ['done'],
};

/**
 * Needs you | Working (includes idle and paused) | Done; counts zero-padded; empty copy from spec §10.
 * Cards keep read-model (spawn) order, as the prototype does — no recency sort (visual baseline, ADR-0012).
 */
export const boardColumns = (model: ReadModel, now: number): BoardColumn[] => {
  const sessions = liveSessions(model);
  const column = (
    key: BoardColumnKey,
    label: string,
    hot: boolean,
    spawn: boolean,
    emptyText: string,
  ): BoardColumn => {
    const items = sessions
      .filter((s) => COLUMN_STATES[key].includes(s.state))
      .map((s) => boardCard(model, s, now));
    return {
      key,
      label,
      hot,
      spawn,
      count: padCount(items.length),
      items,
      empty: items.length === 0,
      emptyText,
    };
  };
  return [
    column('needs-you', copy.board.columns.needsYou, true, false, copy.board.empty.needsYou),
    column('working', copy.board.columns.working, false, true, copy.board.empty.working),
    column('done', copy.board.columns.done, false, false, copy.board.empty.done),
  ];
};

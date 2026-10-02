import type { AskId, ProjectId, SessionId } from '../ids';
import { copy } from '../copy';
import type { Agent } from '../model/common';
import type { AskKind, Session, SessionState } from '../model/session';
import type { ReadModel } from '../read-model';
import { agentLabel, branchOf, headAskOf, isReadyToLand, liveSessions, projectNameOf } from './common';
import { formatAge, padCount } from './format';

export type BoardColumnKey = 'needs-you' | 'working' | 'ready' | 'landed';

export interface BoardCard {
  sessionId: SessionId;
  projectId: ProjectId;
  agent: string;
  /** Which agent, for its colour square (ADR-0027 §7). */
  agentKind: Agent;
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
  /** One line under the label: what the column asks of the person. */
  sub: string;
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

/** Spec §4.3: Open · Review grant · Review plan; a Done card reopens (owner addition #97) and archives from its ghost button. */
const ctaFor = (session: Session, askKind: AskKind | null): string => {
  if (session.state === 'done') return copy.board.actions.reopen;
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
    agentKind: session.agent,
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
  ready: ['done'],
  landed: ['done'],
};

/**
 * A finished session is ready to land while its lane has unmerged changes (ADR-0027, `isReadyToLand`); otherwise
 * it is landed, or finished on main with nothing to land, which the Landed column ("On main") holds too.
 */
const landed = (model: ReadModel, s: Session): boolean => !isReadyToLand(model, s);

/**
 * Your turn | Working (includes idle and paused) | Ready to land | Landed (ADR-0027: Done splits on whether the
 * lane merged); counts zero-padded; empty copy from spec §10.
 * Cards keep read-model (spawn) order, as the prototype does — no recency sort (visual baseline, ADR-0012).
 */
export const boardColumns = (
  model: ReadModel,
  now: number,
  projectId: ProjectId | null = null,
): BoardColumn[] => {
  // Every project's sessions from the app rail; one project's from its nav (owner layout #87).
  const sessions = liveSessions(model).filter(
    (s) => !s.purpose && (projectId === null || s.projectId === projectId),
  );
  const column = (
    key: BoardColumnKey,
    label: string,
    sub: string,
    hot: boolean,
    spawn: boolean,
    emptyText: string,
  ): BoardColumn => {
    const items = sessions
      .filter((s) => COLUMN_STATES[key].includes(s.state))
      .filter((s) => (key === 'ready' ? !landed(model, s) : key === 'landed' ? landed(model, s) : true))
      .map((s) => boardCard(model, s, now));
    return {
      key,
      label,
      sub,
      hot,
      spawn,
      count: padCount(items.length),
      items,
      empty: items.length === 0,
      emptyText,
    };
  };
  return [
    column(
      'needs-you',
      copy.board.columns.needsYou,
      copy.board.sub.needsYou,
      true,
      false,
      copy.board.empty.needsYou,
    ),
    column(
      'working',
      copy.board.columns.working,
      copy.board.sub.working,
      false,
      true,
      copy.board.empty.working,
    ),
    column('ready', copy.board.columns.ready, copy.board.sub.ready, false, false, copy.board.empty.ready),
    column('landed', copy.board.columns.landed, copy.board.sub.landed, false, false, copy.board.empty.landed),
  ];
};

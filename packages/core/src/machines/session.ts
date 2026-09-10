import type { AskId, SessionId } from '../ids';
import type { PausedReason, PendingAsk, Session, SessionState } from '../model/session';

/** Spec §1: idle ─start─▶ working ─ask─▶ needs-you ─ask-resolved─▶ working; finish → done; error → paused ─resolve─▶ working. */
export type SessionEvent =
  | { type: 'start' }
  | { type: 'ask'; askId: AskId }
  | { type: 'ask-resolved'; askId: AskId }
  | { type: 'finish'; exitCode: number | null }
  | { type: 'error'; reason: Exclude<PausedReason, 'user'> }
  /** The user held the agent from the chat (distinct from `error`, which is a fault the app detected). */
  | { type: 'pause' }
  | { type: 'resolve' }
  | { type: 'activity' }
  | { type: 'quiet' };

export type SessionEventType = SessionEvent['type'];

export type SessionEffect =
  | { type: 'notify'; sessionId: SessionId; askId: AskId }
  | { type: 'promoteAsk'; sessionId: SessionId }
  | { type: 'cancelOpenAsks'; sessionId: SessionId }
  | { type: 'cancelTimers'; sessionId: SessionId }
  | { type: 'revokeSessionGrants'; sessionId: SessionId }
  /** Only a fault banners; a user hold has nothing to report, so `user` is excluded here by construction. */
  | { type: 'setBanner'; sessionId: SessionId; reason: Exclude<PausedReason, 'user'> }
  | { type: 'clearBanner'; sessionId: SessionId }
  | { type: 'postSystemMessage'; sessionId: SessionId; body: string };

export interface SessionContext {
  now: number;
  sessionId: SessionId;
  /** Open asks for this session *after* the event has been applied to the queue. */
  openAskCount: number;
  /** The stored reason while paused (kept when an ask is answered from the inbox). */
  pausedReason: PausedReason | null;
  notifyWhenNeedsMe: boolean;
}

export interface SessionTransition {
  state: SessionState;
  pausedReason: PausedReason | null;
  effects: SessionEffect[];
}

type Cell<E extends SessionEvent> = (event: E, ctx: SessionContext) => SessionTransition | null;
type Row = { [E in SessionEvent as E['type']]: Cell<E> };

const ok = (
  state: SessionState,
  effects: SessionEffect[] = [],
  pausedReason: PausedReason | null = null,
): SessionTransition => ({
  state,
  pausedReason,
  effects,
});
const invalid = (): null => null;

const toNeedsYou: Cell<Extract<SessionEvent, { type: 'ask' }>> = (event, ctx) =>
  ok(
    'needs-you',
    ctx.notifyWhenNeedsMe ? [{ type: 'notify', sessionId: ctx.sessionId, askId: event.askId }] : [],
  );

/** needs-you is left only when the open-ask queue is empty; otherwise the next head is promoted and re-notified. */
const afterAskResolved = (ctx: SessionContext): SessionTransition =>
  ctx.openAskCount > 0 ? ok('needs-you', [{ type: 'promoteAsk', sessionId: ctx.sessionId }]) : ok('working');

const finish: Cell<Extract<SessionEvent, { type: 'finish' }>> = (_event, ctx) =>
  ok('done', [
    { type: 'cancelOpenAsks', sessionId: ctx.sessionId },
    { type: 'revokeSessionGrants', sessionId: ctx.sessionId },
    { type: 'cancelTimers', sessionId: ctx.sessionId },
  ]);

const pause: Cell<Extract<SessionEvent, { type: 'error' }>> = (event, ctx) =>
  ok('paused', [{ type: 'setBanner', sessionId: ctx.sessionId, reason: event.reason }], event.reason);

/**
 * User-initiated hold. Unlike `error` it raises no banner: nothing is wrong, the agent is simply held at its
 * next tool boundary until the user resumes, and `resolve` releases it exactly as it releases an error pause.
 */
const holdByUser: Cell<SessionEvent> = () => ok('paused', [], 'user');

const stay =
  (state: SessionState): Cell<SessionEvent> =>
  () =>
    ok(state);

const TABLE: Record<SessionState, Row> = {
  idle: {
    start: () => ok('working'),
    ask: toNeedsYou,
    'ask-resolved': invalid,
    finish,
    error: pause,
    pause: holdByUser,
    resolve: invalid,
    activity: () => ok('working'),
    quiet: invalid,
  },
  working: {
    start: invalid,
    ask: toNeedsYou,
    'ask-resolved': invalid,
    finish,
    error: pause,
    pause: holdByUser,
    resolve: invalid,
    activity: stay('working'),
    quiet: () => ok('idle'),
  },
  'needs-you': {
    start: invalid,
    /** Further asks queue behind the head; the badge does not change. */
    ask: stay('needs-you'),
    'ask-resolved': (_event, ctx) => afterAskResolved(ctx),
    finish,
    error: pause,
    /** Pausing with an ask open is allowed: the ask stays open and answering it later still works. */
    pause: holdByUser,
    resolve: invalid,
    /** needs-you never times out (spec §1). */
    activity: stay('needs-you'),
    quiet: stay('needs-you'),
  },
  done: {
    start: invalid,
    ask: invalid,
    'ask-resolved': invalid,
    finish: invalid,
    error: invalid,
    pause: invalid,
    resolve: invalid,
    activity: invalid,
    quiet: invalid,
  },
  paused: {
    start: invalid,
    ask: invalid,
    /** An ask may be answered from the inbox while paused; the session stays paused. */
    'ask-resolved': (_event, ctx) => ok('paused', [], ctx.pausedReason),
    finish,
    error: pause,
    /** Already held: pausing again is a no-op rather than an error, so a double click is harmless. */
    pause: (_event, ctx) => ok('paused', [], ctx.pausedReason),
    resolve: (_event, ctx) => {
      const next = afterAskResolved(ctx);
      return { ...next, effects: [{ type: 'clearBanner', sessionId: ctx.sessionId }, ...next.effects] };
    },
    activity: invalid,
    quiet: invalid,
  },
};

export const transition = (
  state: SessionState,
  event: SessionEvent,
  ctx: SessionContext,
): SessionTransition | null => {
  const cell = TABLE[state][event.type] as Cell<SessionEvent>;
  return cell(event, ctx);
};

export const SESSION_STATES: readonly SessionState[] = ['idle', 'working', 'needs-you', 'done', 'paused'];
export const SESSION_EVENT_TYPES: readonly SessionEventType[] = [
  'start',
  'ask',
  'ask-resolved',
  'finish',
  'error',
  'pause',
  'resolve',
  'activity',
  'quiet',
];

// --- Queue helpers ---------------------------------------------------------

/** Head ask = lowest position among open asks; only the head surfaces (sheet, board, inbox, toast). */
export const headAsk = <A extends Pick<PendingAsk, 'state' | 'position'>>(asks: readonly A[]): A | null => {
  let head: A | null = null;
  for (const ask of asks) {
    if (ask.state !== 'open') continue;
    if (head === null || ask.position < head.position) head = ask;
  }
  return head;
};

export const openAskCount = (asks: readonly Pick<PendingAsk, 'state'>[]): number =>
  asks.filter((a) => a.state === 'open').length;

/** Number of asks waiting behind the head ("+n queued"). */
export const queuedAskCount = (asks: readonly Pick<PendingAsk, 'state'>[]): number =>
  Math.max(0, openAskCount(asks) - 1);

// --- Retention -------------------------------------------------------------

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Finished sessions land in Done for 7 days, then are archived (RetentionJob, hourly). */
export const shouldArchive = (
  session: Pick<Session, 'state' | 'endedAt' | 'archivedAt'>,
  now: number,
): boolean =>
  session.state === 'done' &&
  session.archivedAt === null &&
  session.endedAt !== null &&
  session.endedAt < now - RETENTION_MS;

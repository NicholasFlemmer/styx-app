import { describe, expect, it } from 'vitest';
import { idFrom } from '../ids';
import type { AskId, SessionId } from '../ids';
import type { PendingAsk, SessionState } from '../model/session';
import {
  RETENTION_MS,
  SESSION_EVENT_TYPES,
  SESSION_STATES,
  headAsk,
  openAskCount,
  queuedAskCount,
  shouldArchive,
  transition,
} from './session';
import type { SessionContext, SessionEvent, SessionEventType } from './session';

const sessionId = idFrom<'SessionId'>('sess-1') as SessionId;
const askId = idFrom<'AskId'>('ask-1') as AskId;

const ctx = (over: Partial<SessionContext> = {}): SessionContext => ({
  now: 1_000,
  sessionId,
  openAskCount: 0,
  pausedReason: null,
  notifyWhenNeedsMe: true,
  ...over,
});

const EVENTS: Record<SessionEventType, SessionEvent> = {
  start: { type: 'start' },
  ask: { type: 'ask', askId },
  'ask-resolved': { type: 'ask-resolved', askId },
  finish: { type: 'finish', exitCode: 0 },
  error: { type: 'error', reason: 'conflict' },
  resolve: { type: 'resolve' },
  activity: { type: 'activity' },
  quiet: { type: 'quiet' },
};

/** Expected next state for every (state, event) pair; `null` = invalid. */
const EXPECTED: Record<SessionState, Record<SessionEventType, SessionState | null>> = {
  idle: {
    start: 'working',
    ask: 'needs-you',
    'ask-resolved': null,
    finish: 'done',
    error: 'paused',
    resolve: null,
    activity: 'working',
    quiet: null,
  },
  working: {
    start: null,
    ask: 'needs-you',
    'ask-resolved': null,
    finish: 'done',
    error: 'paused',
    resolve: null,
    activity: 'working',
    quiet: 'idle',
  },
  'needs-you': {
    start: null,
    ask: 'needs-you',
    'ask-resolved': 'working',
    finish: 'done',
    error: 'paused',
    resolve: null,
    activity: 'needs-you',
    quiet: 'needs-you',
  },
  done: {
    start: null,
    ask: null,
    'ask-resolved': null,
    finish: null,
    error: null,
    resolve: null,
    activity: null,
    quiet: null,
  },
  paused: {
    start: null,
    ask: null,
    'ask-resolved': 'paused',
    finish: 'done',
    error: 'paused',
    resolve: 'working',
    activity: null,
    quiet: null,
  },
};

describe('session machine: every (state, event) pair', () => {
  const cases = SESSION_STATES.flatMap((state) =>
    SESSION_EVENT_TYPES.map((event) => ({ state, event, next: EXPECTED[state][event] })),
  );
  it.each(cases)('$state × $event → $next', ({ state, event, next }) => {
    const result = transition(state, EVENTS[event], ctx());
    if (next === null) expect(result).toBeNull();
    else expect(result?.state).toBe(next);
  });

  it('covers the full table', () => {
    expect(cases).toHaveLength(SESSION_STATES.length * SESSION_EVENT_TYPES.length);
  });
});

describe('session machine: effects and guards', () => {
  it('ask from working notifies when the session wants notifications', () => {
    const r = transition('working', EVENTS.ask, ctx());
    expect(r?.effects).toEqual([{ type: 'notify', sessionId, askId }]);
  });

  it('ask from idle does not notify when notifications are off', () => {
    const r = transition('idle', EVENTS.ask, ctx({ notifyWhenNeedsMe: false }));
    expect(r).toEqual({ state: 'needs-you', pausedReason: null, effects: [] });
  });

  it('a second ask while needs-you queues without effects (badge unchanged)', () => {
    expect(transition('needs-you', EVENTS.ask, ctx({ openAskCount: 2 }))).toEqual({
      state: 'needs-you',
      pausedReason: null,
      effects: [],
    });
  });

  it('needs-you is left only when the queue is empty', () => {
    expect(transition('needs-you', EVENTS['ask-resolved'], ctx({ openAskCount: 0 }))?.state).toBe('working');
    const queued = transition('needs-you', EVENTS['ask-resolved'], ctx({ openAskCount: 1 }));
    expect(queued?.state).toBe('needs-you');
    expect(queued?.effects).toEqual([{ type: 'promoteAsk', sessionId }]);
  });

  it('needs-you never times out: activity and quiet keep the state and emit nothing', () => {
    expect(transition('needs-you', EVENTS.activity, ctx())?.effects).toEqual([]);
    expect(transition('needs-you', EVENTS.quiet, ctx())?.effects).toEqual([]);
  });

  it('finish cancels asks, revokes session grants and timers', () => {
    const r = transition('needs-you', EVENTS.finish, ctx());
    expect(r?.effects.map((e) => e.type)).toEqual(['cancelOpenAsks', 'revokeSessionGrants', 'cancelTimers']);
  });

  it.each(['cli-missing', 'conflict', 'auth-expired'] as const)(
    'error(%s) pauses with the reason and a banner',
    (reason) => {
      const r = transition('working', { type: 'error', reason }, ctx());
      expect(r).toEqual({
        state: 'paused',
        pausedReason: reason,
        effects: [{ type: 'setBanner', sessionId, reason }],
      });
    },
  );

  it('error while paused updates the reason', () => {
    const r = transition(
      'paused',
      { type: 'error', reason: 'auth-expired' },
      ctx({ pausedReason: 'conflict' }),
    );
    expect(r?.pausedReason).toBe('auth-expired');
  });

  it('resolve clears the banner and returns to working, or to needs-you when asks are still open', () => {
    const r = transition('paused', EVENTS.resolve, ctx({ pausedReason: 'conflict' }));
    expect(r).toEqual({
      state: 'working',
      pausedReason: null,
      effects: [{ type: 'clearBanner', sessionId }],
    });
    const q = transition('paused', EVENTS.resolve, ctx({ pausedReason: 'conflict', openAskCount: 1 }));
    expect(q?.state).toBe('needs-you');
    expect(q?.effects.map((e) => e.type)).toEqual(['clearBanner', 'promoteAsk']);
  });

  it('answering an ask from the inbox while paused keeps the paused reason', () => {
    const r = transition('paused', EVENTS['ask-resolved'], ctx({ pausedReason: 'cli-missing' }));
    expect(r).toEqual({ state: 'paused', pausedReason: 'cli-missing', effects: [] });
  });

  it('quiet from working goes idle; activity from idle goes working', () => {
    expect(transition('working', EVENTS.quiet, ctx())).toEqual({
      state: 'idle',
      pausedReason: null,
      effects: [],
    });
    expect(transition('idle', EVENTS.activity, ctx())).toEqual({
      state: 'working',
      pausedReason: null,
      effects: [],
    });
  });
});

describe('queue helpers', () => {
  const ask = (
    position: number,
    state: PendingAsk['state'] = 'open',
  ): Pick<PendingAsk, 'state' | 'position'> => ({ state, position });

  it('headAsk = lowest open position; null when none open', () => {
    expect(headAsk([ask(2), ask(0, 'resolved'), ask(1)])).toEqual(ask(1));
    expect(headAsk([ask(1), ask(0)])).toEqual(ask(0));
    expect(headAsk([ask(0), ask(1)])).toEqual(ask(0));
    expect(headAsk([ask(0, 'cancelled')])).toBeNull();
    expect(headAsk([])).toBeNull();
  });

  it('openAskCount / queuedAskCount', () => {
    expect(openAskCount([ask(0), ask(1), ask(2, 'resolved')])).toBe(2);
    expect(queuedAskCount([ask(0), ask(1), ask(2, 'resolved')])).toBe(1);
    expect(queuedAskCount([])).toBe(0);
  });
});

describe('retention', () => {
  const now = 10 * RETENTION_MS;
  it.each([
    ['done, ended 8 days ago', { state: 'done', endedAt: now - RETENTION_MS - 1, archivedAt: null }, true],
    [
      'done, ended exactly 7 days ago',
      { state: 'done', endedAt: now - RETENTION_MS, archivedAt: null },
      false,
    ],
    ['done, ended yesterday', { state: 'done', endedAt: now - 1, archivedAt: null }, false],
    ['already archived', { state: 'done', endedAt: 0, archivedAt: now }, false],
    ['done but no endedAt', { state: 'done', endedAt: null, archivedAt: null }, false],
    ['working', { state: 'working', endedAt: null, archivedAt: null }, false],
  ] as const)('%s', (_label, session, expected) => {
    expect(shouldArchive(session, now)).toBe(expected);
  });
});

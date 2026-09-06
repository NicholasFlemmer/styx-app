import type { SessionId } from '../ids';
import { copy, fill } from '../copy';
import { queuedAskCount } from '../machines/session';
import type { Session } from '../model/session';
import type { ReadModel } from '../read-model';
import { asksOf, branchOf } from './common';
import { formatAge } from './format';

/** `$0.12` — running cost from the stream's `result` events, two decimals. */
export const formatCost = (usd: number): string => `$${usd.toFixed(2)}`;

/** "$0.12 · 3 turns" once a stream session has reported usage; null before the first `result`. */
export const usageLabel = (session: Pick<Session, 'costUsd' | 'numTurns'>): string | null =>
  session.costUsd > 0 || session.numTurns > 0
    ? fill(copy.chat.controls.usage, { cost: formatCost(session.costUsd), turns: session.numTurns })
    : null;

/**
 * "codex · test/flaky · 3m · waiting on you" (agent id lowercase, branch, age, suffix when needs-you), then
 * "$0.12 · 3 turns" once the session has reported usage (Claude Code parity, discrepancy #54).
 */
export const chatMeta = (model: ReadModel, sessionId: SessionId, now: number): string => {
  const session = model.sessions.byId[sessionId];
  if (session === undefined) return '';
  const parts = [session.agent, branchOf(model, session), formatAge(session.lastActivityAt, now)];
  if (session.state === 'needs-you') parts.push(copy.chat.waitingOnYou);
  const usage = usageLabel(session);
  if (usage !== null) parts.push(usage);
  return parts.join(' · ');
};

/** "+n queued" label for asks behind the head, or null when none. */
export const queuedLabel = (model: ReadModel, sessionId: SessionId): string | null => {
  const n = queuedAskCount(asksOf(model, sessionId));
  return n === 0 ? null : fill(copy.board.queued, { n });
};

export const composerPlaceholder = (model: ReadModel, sessionId: SessionId): string => {
  const session = model.sessions.byId[sessionId];
  const agent = session === undefined ? '' : copy.agents[session.agent];
  return fill(copy.chat.composerPlaceholder, { agent });
};

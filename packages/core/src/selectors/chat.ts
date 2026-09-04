import type { SessionId } from '../ids';
import { copy, fill } from '../copy';
import { queuedAskCount } from '../machines/session';
import type { ReadModel } from '../read-model';
import { asksOf, branchOf } from './common';
import { formatAge } from './format';

/** "codex · test/flaky · 3m · waiting on you" (agent id lowercase, branch, age, suffix when needs-you). */
export const chatMeta = (model: ReadModel, sessionId: SessionId, now: number): string => {
  const session = model.sessions.byId[sessionId];
  if (session === undefined) return '';
  const parts = [session.agent, branchOf(model, session), formatAge(session.lastActivityAt, now)];
  if (session.state === 'needs-you') parts.push(copy.chat.waitingOnYou);
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

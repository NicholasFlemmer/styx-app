import type { SessionId } from '../ids';
import { copy, fill } from '../copy';
import { queuedAskCount } from '../machines/session';
import type { Session } from '../model/session';
import type { ReadModel } from '../read-model';
import { asksOf, branchOf } from './common';
import { formatAge } from './format';

/** `$0.12` — running cost from the stream's `result` events, two decimals. */
export const formatCost = (usd: number): string => `$${usd.toFixed(2)}`;

/** `14.6k` — token totals, one decimal above a thousand. */
export const formatTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

/**
 * "$0.12 · 3 turns" once a stream session has reported usage; "14.6k tokens · 3 turns" for a CLI that counts
 * tokens rather than dollars (Codex); null before anything was reported.
 */
export const usageLabel = (
  session: Pick<Session, 'costUsd' | 'numTurns'> & { tokensUsed?: number | undefined },
): string | null => {
  const tokens = session.tokensUsed ?? 0;
  const turns = copy.chat.controls.turns(session.numTurns);
  if (session.costUsd === 0 && tokens > 0)
    return fill(copy.chat.controls.usageTokens, { tokens: formatTokens(tokens), turns });
  // A CLI that reports neither dollars nor tokens (ACP agents) still counts turns: "$0.00" would be a claim.
  if (session.costUsd === 0 && session.numTurns > 0) return turns;
  return session.costUsd > 0
    ? fill(copy.chat.controls.usage, { cost: formatCost(session.costUsd), turns })
    : null;
};

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

export type MidTurnDelivery = 'steer' | 'queue';

/**
 * What happens to a message sent while the agent is mid-turn. Codex over its app-server can take input into the
 * running turn (`turn/steer`); every other runner — Claude Code's stdin, ACP, print mode, a TUI on a pty — holds
 * it in the session queue until the turn settles.
 */
export const deliveryWhileWorking = (session: Pick<Session, 'agent' | 'runner'>): MidTurnDelivery =>
  session.agent === 'codex' && session.runner === 'stream' ? 'steer' : 'queue';

/**
 * A session takes a chat message into its queue (or steers) only while a turn is running: `working`, or blocked
 * on an ask (`needs-you`) — the CLI does not read a new turn until the ask is answered. A shell has no turns.
 */
export const isMidTurn = (session: Pick<Session, 'agent' | 'state'>): boolean =>
  session.agent !== 'shell' && (session.state === 'working' || session.state === 'needs-you');

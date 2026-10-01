import { changeLabel, copy, fill, stepOf, stepsLabel, turnDoneLabel, type Checkpoint } from '@styx/core';
import type { Step } from '@styx/ui';
import type { TranscriptItem } from './transcript-items';

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>;
type CheckpointItem = Extract<TranscriptItem, { kind: 'checkpoint' }>;

/**
 * What the chat draws for a lane (ADR-0027 §3 / §4): the transcript, with each run of tool rows as plain steps, a
 * turn that changed something ending on paper (its last reply moves onto the card), and the turns before the
 * latest folded to one-line receipts.
 */
export type LaneItem =
  | Exclude<TranscriptItem, ToolItem | CheckpointItem>
  | {
      id: string;
      kind: 'steps';
      steps: Step[];
      tools: ToolItem[];
      summary: string;
      /** The run the agent is in right now: listed, last step live. */
      live: boolean;
      /** In the latest turn: listed until folded by hand (older turns start folded). */
      latest: boolean;
    }
  | {
      id: string;
      kind: 'result';
      checkpointId: string;
      done: string;
      change: string;
      /** The agent's last reply in the turn, shown on the card; null when the turn ended without one. */
      text: string | null;
      undone: boolean;
      before: string | undefined;
      after: string | undefined;
    }
  | {
      id: string;
      kind: 'receipt';
      turnId: string;
      title: string;
      meta: string;
      state: 'kept' | 'undone' | 'answered';
    }
  | { id: string; kind: 'earlier'; label: string; folded: boolean }
  | { id: string; kind: 'fold'; turnId: string };

export interface LaneContext {
  /** The session's checkpoints, for each turn's duration and screenshots. */
  checkpoints: readonly Checkpoint[];
  /** When a transcript row was written. */
  atOf: (messageId: string) => number | null;
  /** The agent is mid-turn: the last turn's last run of steps is live. */
  live: boolean;
  /** Turns opened from their receipt, by the id of the message that started them. */
  expanded: ReadonlySet<string>;
  /** "Show them": every earlier turn open. */
  showAll: boolean;
  /** Wall-clock time for receipts ("09:12"). */
  clock: (ms: number) => string;
  /** Where main serves a checkpoint screenshot. */
  screenUrl: (checkpointId: string, side: 'before' | 'after') => string;
}

const RECEIPT_TITLE_MAX = 90;

const firstLine = (text: string): string => {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ?? '';
  return line.length > RECEIPT_TITLE_MAX ? `${line.slice(0, RECEIPT_TITLE_MAX - 1).trimEnd()}…` : line;
};

/** A turn still waiting on the person stays open: folding it would hide the question. */
const asksOpen = (item: TranscriptItem): boolean =>
  ((item.kind === 'decision' || item.kind === 'questions' || item.kind === 'plan') && item.open) ||
  item.kind === 'accessRequest';

interface Turn {
  user: Extract<TranscriptItem, { kind: 'user' }> | null;
  rest: TranscriptItem[];
}

const splitTurns = (items: readonly TranscriptItem[]): Turn[] => {
  const turns: Turn[] = [{ user: null, rest: [] }];
  for (const item of items) {
    if (item.kind === 'user') turns.push({ user: item, rest: [] });
    else turns[turns.length - 1]?.rest.push(item);
  }
  return turns.filter((t) => t.user !== null || t.rest.length > 0);
};

/** One turn's rows: tool runs as steps, the checkpoint as a paper result carrying the last reply. */
const turnBody = (turn: Turn, ctx: LaneContext, live: boolean, latest: boolean): LaneItem[] => {
  const checkpoint = turn.rest.find((i): i is CheckpointItem => i.kind === 'checkpoint') ?? null;
  const lastAgentIndex = checkpoint === null ? -1 : turn.rest.map((i) => i.kind).lastIndexOf('agent');
  const out: LaneItem[] = [];
  let run: ToolItem[] = [];
  const flush = (trailing: boolean) => {
    if (run.length === 0) return;
    const failed = run.filter((t) => t.status === 'error').length;
    out.push({
      id: `steps:${run[0]?.id ?? ''}`,
      kind: 'steps',
      steps: run.map((t) => ({ key: t.id, label: stepOf(t.tool, t.hint), status: t.status })),
      tools: run,
      summary: stepsLabel(run.length, failed),
      live: live && trailing,
      latest,
    });
    run = [];
  };
  let reply: string | null = null;
  for (const [i, item] of turn.rest.entries()) {
    if (item.kind === 'tool') {
      run.push(item);
      continue;
    }
    flush(false);
    if (item.kind === 'checkpoint') continue;
    if (i === lastAgentIndex && item.kind === 'agent' && !item.streaming) {
      reply = item.text;
      continue;
    }
    out.push(item);
  }
  flush(true);
  if (checkpoint !== null) {
    const c = ctx.checkpoints.find((x) => x.id === checkpoint.checkpointId);
    const settled = c?.settledAt ?? null;
    out.push({
      id: `result:${checkpoint.checkpointId}`,
      kind: 'result',
      checkpointId: checkpoint.checkpointId,
      done: c === undefined || settled === null ? '' : turnDoneLabel(settled - c.createdAt),
      change: changeLabel(checkpoint),
      text: reply,
      undone: checkpoint.reverted,
      before:
        c?.screens.includes('before') === true ? ctx.screenUrl(checkpoint.checkpointId, 'before') : undefined,
      after:
        c?.screens.includes('after') === true ? ctx.screenUrl(checkpoint.checkpointId, 'after') : undefined,
    });
  }
  return out;
};

const receiptOf = (turn: Turn & { user: NonNullable<Turn['user']> }, ctx: LaneContext): LaneItem => {
  const checkpoint = turn.rest.find((i): i is CheckpointItem => i.kind === 'checkpoint') ?? null;
  const c = checkpoint === null ? undefined : ctx.checkpoints.find((x) => x.id === checkpoint.checkpointId);
  const lastRow = turn.rest.at(-1);
  const at = c?.settledAt ?? ctx.atOf(lastRow?.id ?? turn.user.id) ?? ctx.atOf(turn.user.id);
  const time = at === null ? '' : ctx.clock(at);
  const state = checkpoint === null ? 'answered' : checkpoint.reverted ? 'undone' : 'kept';
  const meta = fill(
    state === 'answered'
      ? copy.chat.turn.receiptAnswered
      : state === 'undone'
        ? copy.chat.turn.receiptUndone
        : copy.chat.turn.receiptKept,
    { time },
  ).trim();
  return {
    id: `receipt:${turn.user.id}`,
    kind: 'receipt',
    turnId: turn.user.id,
    title: firstLine(turn.user.text) || copy.chat.turn.receiptAnswered.replace(' {time}', ''),
    meta,
    state,
  };
};

export const laneItems = (items: readonly TranscriptItem[], ctx: LaneContext): LaneItem[] => {
  const turns = splitTurns(items);
  const out: LaneItem[] = [];
  const lastIndex = turns.length - 1;
  // The latest turn stays open, and while the agent works so does the one before it: a message sent mid-turn
  // (Codex steers) starts a new row while the earlier turn is still running, and the last result stays in view
  // while the next one works.
  const firstOpen = lastIndex - (ctx.live ? 1 : 0);
  // Turns before those, started by the person, with nothing still asking them: these may fold.
  const foldable = (t: Turn, i: number): t is Turn & { user: NonNullable<Turn['user']> } =>
    i < firstOpen && t.user !== null && !t.rest.some(asksOpen);
  const earlier = turns.filter(foldable).length;
  if (earlier > 0)
    out.push({
      id: 'earlier',
      kind: 'earlier',
      label: earlier === 1 ? copy.chat.turn.earlierOne : fill(copy.chat.turn.earlier, { n: earlier }),
      folded: !ctx.showAll,
    });
  turns.forEach((turn, i) => {
    if (foldable(turn, i) && !ctx.showAll && !ctx.expanded.has(turn.user.id)) {
      out.push(receiptOf(turn, ctx));
      return;
    }
    if (foldable(turn, i) && !ctx.showAll)
      out.push({ id: `fold:${turn.user.id}`, kind: 'fold', turnId: turn.user.id });
    if (turn.user !== null) out.push(turn.user);
    out.push(...turnBody(turn, ctx, ctx.live && i === lastIndex, i >= firstOpen));
  });
  return out;
};

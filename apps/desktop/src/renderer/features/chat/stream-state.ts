import { copy, fill, type ReadModel, type SessionId, type TranscriptMessage } from '@styx/core';

/** Seconds for the "Thought for {s}s" / "{s}s" labels: rounded, never below 1s. */
export const wholeSeconds = (ms: number): number => Math.max(1, Math.round(ms / 1000));

/**
 * Header of a thinking block (discrepancy #55): "Thinking…" while streaming, "Thought for 4s" once done with a
 * known duration, and a bare "Thinking" when the stream ended without one (never a made-up "1s").
 */
export const thinkingLabel = (status: 'streaming' | 'done', durationMs: number | null): string => {
  if (status === 'streaming') return copy.chat.thinking.streaming;
  if (durationMs !== null) return fill(copy.chat.thinking.done, { s: wholeSeconds(durationMs) });
  return copy.chat.thinking.streaming.replace(/…$/, '');
};

export interface WorkingLineState {
  label: string;
  elapsedMs: number;
}

const bySeq = (messages: readonly TranscriptMessage[]): TranscriptMessage[] =>
  [...messages].sort((a, b) => a.seq - b.seq);

const isStreaming = (m: TranscriptMessage): boolean =>
  (m.payload.kind === 'agent' && m.payload.streaming === true) ||
  (m.payload.kind === 'thinking' && m.payload.status === 'streaming');

/**
 * The live working line under the transcript (discrepancy #55): only while the session is `working` and nothing
 * is streaming (a streaming bubble's cursor already shows progress). Label: "Running {tool}…" while the latest
 * tool call is still running; "Thinking…" right after the user's message or a finished thinking block; else
 * "Working…". Elapsed counts from the user's last message (fallback: the session's last activity).
 */
export const workingLine = (model: ReadModel, sessionId: SessionId, now: number): WorkingLineState | null => {
  const session = model.sessions.byId[sessionId];
  if (session === undefined || session.state !== 'working') return null;
  const messages = bySeq(model.transcripts[sessionId] ?? []);
  const last = messages[messages.length - 1];
  if (last !== undefined && isStreaming(last)) return null;

  const lastTool = messages.filter((m) => m.payload.kind === 'tool').at(-1);
  const running =
    lastTool?.payload.kind === 'tool' && lastTool.payload.status === 'running' ? lastTool : undefined;
  const label =
    running?.payload.kind === 'tool'
      ? fill(copy.chat.working.tool, { tool: running.payload.tool })
      : last?.payload.kind === 'thinking' || last?.payload.kind === 'user'
        ? copy.chat.working.thinking
        : copy.chat.working.working;

  const lastUser = messages.filter((m) => m.payload.kind === 'user').at(-1);
  const since = lastUser?.createdAt ?? session.lastActivityAt ?? null;
  const elapsedMs = since === null ? 0 : Math.max(0, now - since);
  return { label, elapsedMs };
};

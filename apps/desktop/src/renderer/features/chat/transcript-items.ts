import {
  AGENT_LABEL,
  copy,
  type Agent,
  type Attachment,
  type AskAnswer,
  type AskId,
  type AskQuestion,
  type GrantId,
  type ReadModel,
  type Scope,
  type SessionId,
  type TranscriptMessage,
} from '@styx/core';
import { hunkMatchesFile, hunkBody } from '../editor/hunk-decorations';

export type TranscriptItem =
  | {
      id: string;
      kind: 'user';
      text: string;
      attachments: readonly Attachment[];
      /** What the message points at (#140): the chip's label. */
      pointer?: string;
    }
  | {
      id: string;
      kind: 'agent';
      text: string;
      /** The body is still being patched from the stream: renders a cursor (discrepancy #55). */
      streaming: boolean;
    }
  | {
      id: string;
      kind: 'thinking';
      text: string;
      status: 'streaming' | 'done';
      durationMs: number | null;
    }
  | { id: string; kind: 'fileList'; files: { path: string; added: number; removed?: number }[] }
  | {
      id: string;
      kind: 'decision';
      text: string;
      options: string[];
      askId: AskId | null;
      /** The option already taken (payload `chosen`), once the ask was answered here or in the CLI. */
      chosen: string | null;
      /** The ask is still open (or the row has no ask): options stay clickable. */
      open: boolean;
    }
  | {
      id: string;
      kind: 'questions';
      /** The whole AskUserQuestion set, answered together in one card. */
      questions: readonly AskQuestion[];
      askId: AskId | null;
      /** Answers from the resolved ask; null while the card is still open. */
      answers: readonly AskAnswer[] | null;
      open: boolean;
    }
  | {
      id: string;
      kind: 'plan';
      text: string;
      files: string[];
      askId: AskId | null;
      outcome: 'approved' | 'rejected' | null;
      open: boolean;
    }
  | {
      id: string;
      kind: 'tool';
      tool: string;
      hint: string;
      status: 'running' | 'ok' | 'error';
      detail: string | null;
    }
  | {
      id: string;
      kind: 'accessRequest';
      target: string;
      env: string | undefined;
      scopes: string[];
      grantId: GrantId;
      askId: AskId | null;
    }
  | {
      id: string;
      kind: 'peer';
      text: string;
      /** The other agent in the exchange (the sender when inbound, the recipient when not). */
      agent: string;
      branch: string | null;
      inbound: boolean;
    }
  | { id: string; kind: 'system'; text: string }
  /** The agent's account stopped it (signed out, out of usage): a sentence and the fix, not the CLI's error. */
  | { id: string; kind: 'agent-problem'; text: string; agent: Agent; problem: 'signed-out' | 'limit' }
  | {
      /** A settled turn with changes (ADR-0020): sits after the turn's last row, before the next user message. */
      id: string;
      kind: 'checkpoint';
      checkpointId: string;
      turn: number;
      files: number;
      added: number;
      removed: number;
      /** The workspace was restored to before this turn (by reverting it or an earlier one). */
      reverted: boolean;
    };

/** "read schema" · "write" · "delete / drop" · "deploy" (spec §10 access-request card, lowercase). */
export const scopeLabel = (scope: Scope): string => copy.grantSheet.scopes[scope].toLowerCase();

/** A file the agent modified (vs. created): some hunk of it removes or keeps old lines. */
const preExisting = (model: ReadModel, sessionId: SessionId, path: string): boolean =>
  (model.hunks[sessionId] ?? []).some(
    (h) =>
      hunkMatchesFile(h, path) &&
      (h.oldLines > 0 || hunkBody(h.patch).some((l) => !l.startsWith('+') && l.trim() !== '')),
  );

/** A decision row without an ask (prototype transcript) is always answerable; with one, only while it is open. */
export const askOpen = (model: ReadModel, askId: AskId | null): boolean =>
  askId === null ? true : model.pendingAsks.byId[askId]?.state === 'open';

/**
 * Transcript rows → Message props (spec §8 Message kinds). Access-request cards disappear once the grant is
 * decided (the system line / agent reply that follows stands in, prototype `codexGranted` / `codexDenied`).
 */
export const transcriptItems = (model: ReadModel, sessionId: SessionId): TranscriptItem[] => {
  const messages: readonly TranscriptMessage[] = model.transcripts[sessionId] ?? [];
  const out: TranscriptItem[] = [];
  // Settled turns with changes, by the user row that started them; the row lands before the next user message.
  const checkpoints = new Map<string, Extract<TranscriptItem, { kind: 'checkpoint' }>>();
  for (const c of model.checkpoints[sessionId] ?? []) {
    if (c.messageId === null || c.ref === null || c.files === 0) continue;
    checkpoints.set(c.messageId, {
      id: `checkpoint:${c.id}`,
      kind: 'checkpoint',
      checkpointId: c.id,
      turn: c.turn,
      files: c.files,
      added: c.added,
      removed: c.removed,
      reverted: c.revertedAt !== null,
    });
  }
  let turnRow: Extract<TranscriptItem, { kind: 'checkpoint' }> | null = null;
  for (const m of [...messages].sort((a, b) => a.seq - b.seq)) {
    const p = m.payload;
    if (p.kind === 'user' && turnRow !== null) {
      out.push(turnRow);
      turnRow = null;
    }
    switch (p.kind) {
      case 'user':
        out.push({
          id: m.id,
          kind: 'user',
          text: m.body,
          attachments: p.attachments ?? [],
          ...(p.pointer !== undefined ? { pointer: p.pointer.label } : {}),
        });
        turnRow = checkpoints.get(m.id) ?? null;
        break;
      case 'agent': {
        // Rows written before question sets existed carry an ask but render as prose, which left the session
        // stuck in needs-you with nothing to answer. Any agent row still holding an open question ask gets the
        // card instead.
        const ask = m.askId === null ? null : (model.pendingAsks.byId[m.askId] ?? null);
        if (ask !== null && ask.state === 'open' && ask.payload.kind === 'question') {
          out.push({
            id: m.id,
            kind: 'questions',
            questions: [
              { key: ask.payload.prompt, header: null, prompt: m.body, multiSelect: false, options: [] },
            ],
            askId: m.askId,
            answers: null,
            open: true,
          });
          break;
        }
        out.push({ id: m.id, kind: 'agent', text: m.body, streaming: p.streaming === true });
        break;
      }
      case 'thinking':
        out.push({ id: m.id, kind: 'thinking', text: m.body, status: p.status, durationMs: p.durationMs });
        break;
      case 'system':
        if (p.problem !== undefined)
          out.push({
            id: m.id,
            kind: 'agent-problem',
            text: m.body,
            agent: p.problem.agent,
            problem: p.problem.kind,
          });
        else out.push({ id: m.id, kind: 'system', text: m.body });
        break;
      case 'peer':
        out.push({
          id: m.id,
          kind: 'peer',
          text: m.body,
          agent: AGENT_LABEL[p.fromAgent],
          branch: p.fromBranch,
          inbound: p.inbound,
        });
        break;
      case 'file-list':
        out.push({
          id: m.id,
          kind: 'fileList',
          files: p.files.map((f) =>
            f.removed > 0 || preExisting(model, sessionId, f.path)
              ? { path: f.path, added: f.added, removed: f.removed }
              : { path: f.path, added: f.added },
          ),
        });
        break;
      case 'decision':
        out.push({
          id: m.id,
          kind: 'decision',
          text: m.body,
          options: [...p.options],
          askId: m.askId,
          chosen: p.chosen,
          open: askOpen(model, m.askId),
        });
        break;
      case 'questions': {
        // Answers live on the resolved ask (transcript payloads are append-only), so a set answered here or in
        // the CLI both render as answered.
        const res = m.askId === null ? null : (model.pendingAsks.byId[m.askId]?.resolution ?? null);
        out.push({
          id: m.id,
          kind: 'questions',
          questions: p.questions,
          askId: m.askId,
          answers: res?.kind === 'questions' ? res.answers : p.answers,
          open: askOpen(model, m.askId),
        });
        break;
      }
      case 'plan': {
        const res = m.askId === null ? null : (model.pendingAsks.byId[m.askId]?.resolution ?? null);
        out.push({
          id: m.id,
          kind: 'plan',
          text: m.body,
          files: [...p.files],
          askId: m.askId,
          outcome: res?.kind === 'plan' ? res.outcome : p.outcome,
          open: askOpen(model, m.askId),
        });
        break;
      }
      case 'tool':
        out.push({ id: m.id, kind: 'tool', tool: p.tool, hint: p.hint, status: p.status, detail: p.detail });
        break;
      case 'access-request': {
        const grant = model.grants.byId[p.grantId];
        if (grant !== undefined && grant.state !== 'requested') break;
        const target = model.targets.byId[p.targetId];
        out.push({
          id: m.id,
          kind: 'accessRequest',
          target: target?.name ?? p.targetLabel,
          env: target?.env,
          scopes: p.scope.map(scopeLabel),
          grantId: p.grantId,
          askId: m.askId,
        });
        break;
      }
    }
  }
  if (turnRow !== null) out.push(turnRow);
  return out;
};

const FILE_RE = /\b[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|json|css|html?|md|mdx|ya?ml|sh|sql|py|go|rs)\b/g;

/** Splits body text into plain and file-name segments (rendered mono, prototype agent bubbles). */
export const inlineSegments = (text: string): { text: string; code: boolean }[] => {
  const out: { text: string; code: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(FILE_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at), code: false });
    out.push({ text: m[0], code: true });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), code: false });
  return out;
};

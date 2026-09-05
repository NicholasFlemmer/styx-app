import {
  copy,
  type AskId,
  type GrantId,
  type ReadModel,
  type Scope,
  type SessionId,
  type TranscriptMessage,
} from '@styx/core';
import { hunkMatchesFile, hunkBody } from '../editor/hunk-decorations';

export type TranscriptItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'agent'; text: string }
  | { id: string; kind: 'fileList'; files: { path: string; added: number; removed?: number }[] }
  | { id: string; kind: 'decision'; text: string; options: string[]; askId: AskId | null }
  | {
      id: string;
      kind: 'accessRequest';
      target: string;
      env: string | undefined;
      scopes: string[];
      grantId: GrantId;
      askId: AskId | null;
    }
  | { id: string; kind: 'system'; text: string };

/** "read schema" · "write" · "delete / drop" · "deploy" (spec §10 access-request card, lowercase). */
export const scopeLabel = (scope: Scope): string => copy.grantSheet.scopes[scope].toLowerCase();

/** A file the agent modified (vs. created): some hunk of it removes or keeps old lines. */
const preExisting = (model: ReadModel, sessionId: SessionId, path: string): boolean =>
  (model.hunks[sessionId] ?? []).some(
    (h) => hunkMatchesFile(h, path) && (h.oldLines > 0 || hunkBody(h.patch).some((l) => !l.startsWith('+'))),
  );

/**
 * Transcript rows → Message props (spec §8 Message kinds). Access-request cards disappear once the grant is
 * decided (the system line / agent reply that follows stands in, prototype `codexGranted` / `codexDenied`).
 */
export const transcriptItems = (model: ReadModel, sessionId: SessionId): TranscriptItem[] => {
  const messages: readonly TranscriptMessage[] = model.transcripts[sessionId] ?? [];
  const out: TranscriptItem[] = [];
  for (const m of [...messages].sort((a, b) => a.seq - b.seq)) {
    const p = m.payload;
    switch (p.kind) {
      case 'user':
        out.push({ id: m.id, kind: 'user', text: m.body });
        break;
      case 'agent':
        out.push({ id: m.id, kind: 'agent', text: m.body });
        break;
      case 'system':
        out.push({ id: m.id, kind: 'system', text: m.body });
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
        out.push({ id: m.id, kind: 'decision', text: m.body, options: [...p.options], askId: m.askId });
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

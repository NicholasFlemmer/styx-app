import type { TranscriptMessage } from '@styx/core';
import { redact } from './logger';

/**
 * A lane's conversation as one self-contained page, shared as a link anyone can read (ADR-0032, the lean hub,
 * mockup design/next/styx-next-share-links.html frame 2). Only what people and the agent said: no tool steps, no
 * thinking, no system notes. Everything is escaped and redacted; the page carries no script, so the share origin's
 * sandbox has nothing to run.
 */

export interface SharedTurn {
  who: string;
  /** The agent's name when the agent said it; null for the person. */
  agent: string | null;
  text: string;
  highlight: boolean;
}

/** The person's words and the agent's answers, in order; one answer only when `messageId` names it. */
export const turnsOf = (
  messages: readonly TranscriptMessage[],
  person: string,
  agent: string,
  messageId: string | null,
): SharedTurn[] => {
  const said = messages.filter(
    (m) =>
      (m.payload.kind === 'user' || (m.payload.kind === 'agent' && m.payload.streaming !== true)) &&
      m.body.trim() !== '',
  );
  if (messageId !== null) {
    const at = said.findIndex((m) => m.id === messageId);
    if (at === -1) return [];
    // The answer, with the question it answers when there is one just before it.
    const prev = said[at - 1];
    const pick = prev !== undefined && prev.payload.kind === 'user' ? [prev, said[at]] : [said[at]];
    return pick.flatMap((m) =>
      m === undefined ? [] : [{ ...turnOf(m, person, agent), highlight: m.id === messageId }],
    );
  }
  return said.map((m) => ({ ...turnOf(m, person, agent), highlight: false }));
};

const turnOf = (m: TranscriptMessage, person: string, agent: string) =>
  m.payload.kind === 'user'
    ? { who: person, agent: null, text: redact(m.body) }
    : { who: person, agent, text: redact(m.body) };

const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

/** Paragraphs, fenced code blocks and `inline code`; every character of the text escaped first. */
export const textToHtml = (text: string): string => {
  const out: string[] = [];
  const parts = text.split(/^```[^\n]*\n?/m);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      out.push(`<pre>${esc(part.replace(/\n$/, ''))}</pre>`);
      return;
    }
    for (const para of part.split(/\n{2,}/)) {
      const t = para.trim();
      if (t === '') continue;
      const inline = esc(t)
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\n/g, '<br>');
      out.push(`<p>${inline}</p>`);
    }
  });
  return out.join('\n');
};

/** The page's stylesheet, sent as `style.css` beside it: two files make the hub treat it as a page, not code. */
export const CONVERSATION_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#f7f8f3;color:#14160f;font:400 15px/1.6 'Archivo',system-ui,-apple-system,'Segoe UI',sans-serif;padding:32px 24px 48px}
main{max-width:760px;margin:0 auto}
.meta{font-size:13px;color:#5d6259}
h1{font:600 28px/1.2 'Archivo',system-ui,sans-serif;margin:8px 0 24px}
.turn{padding:18px 0;border-top:1px solid #e1e3db}
.turn.hl{background:#eef3d6;margin:0 -16px;padding:18px 16px;border-top-color:#b3b7ab}
.who{font-size:12px;color:#5d6259;margin-bottom:6px}
.who b{color:#14160f;font-weight:600}
p{margin:0 0 10px}
p:last-child{margin-bottom:0}
code{font:400 13px 'JetBrains Mono',ui-monospace,Menlo,monospace;background:#e1e3db;padding:1px 4px}
pre{font:400 13px/1.5 'JetBrains Mono',ui-monospace,Menlo,monospace;background:#14160f;color:#e9ebe3;padding:12px 14px;margin:0 0 10px;overflow-x:auto;white-space:pre}
footer{margin-top:28px;padding-top:14px;border-top:1px solid #b3b7ab;font-size:12px;color:#5d6259}
`;

export const conversationPage = (input: {
  title: string;
  team: string;
  sharedBy: string;
  project: string;
  when: string;
  turns: readonly SharedTurn[];
}): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<title>${esc(input.title)}</title><link rel="stylesheet" href="style.css"></head><body><main>` +
  `<div class="meta">${esc([input.team, `shared by ${input.sharedBy} from Styx`, input.project, input.when].filter((x) => x !== '').join(' · '))}</div>` +
  `<h1>${esc(input.title)}</h1>` +
  input.turns
    .map(
      (t) =>
        `<section class="turn${t.highlight ? ' hl' : ''}"><div class="who">${
          t.agent === null ? `<b>${esc(t.who)}</b>` : `<b>${esc(t.agent)}</b> for ${esc(t.who)}`
        }</div>${textToHtml(t.text)}</section>`,
    )
    .join('') +
  `<footer>Read only. Shared with Styx.</footer></main></body></html>`;

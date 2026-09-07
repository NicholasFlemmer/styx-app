/**
 * Dependency-free markdown → block tree for agent replies (owner addition, docs/handoff-discrepancies #57).
 * Covers what coding agents emit: paragraphs, `#`–`###` headings, bold / italic, inline code, fenced code
 * (an unterminated fence still renders as a code block while streaming), ordered / unordered lists nested by
 * indentation, blockquotes, rules, links, tables and hard line breaks. Everything else stays literal text —
 * the renderer never injects HTML. Pure; no DOM.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'break' };

export type Align = 'left' | 'center' | 'right' | null;

export interface ListItem {
  children: Block[];
}

export type Block =
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'heading'; level: 1 | 2 | 3; children: Inline[] }
  | {
      kind: 'code';
      lang: string | null;
      text: string;
      /** The closing fence has not arrived (streaming). */
      open: boolean;
    }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'quote'; children: Block[] }
  | { kind: 'rule' }
  | { kind: 'table'; align: Align[]; header: Inline[][]; rows: Inline[][][] };

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)[ \t]*$/;
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RULE_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE_RE = /^ {0,3}>[ \t]?(.*)$/;
const LIST_RE = /^( *)([-*+]|\d{1,9}[.)])( +)(.*)$/;
const LIST_EMPTY_RE = /^( *)([-*+]|\d{1,9}[.)])[ \t]*$/;
const TABLE_DELIM_RE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

const isBlank = (line: string): boolean => line.trim() === '';

interface ListLine {
  indent: number;
  ordered: boolean;
  start: number;
  /** Column where the item's content starts (marker + following spaces). */
  contentIndent: number;
  text: string;
}

const listLine = (line: string): ListLine | null => {
  const m = LIST_RE.exec(line);
  if (m !== null) {
    const indent = m[1]?.length ?? 0;
    const marker = m[2] ?? '-';
    const gap = m[3]?.length ?? 1;
    const ordered = /\d/.test(marker);
    // Five or more spaces after the marker start an indented code block in CommonMark; we treat them as one.
    const contentIndent = indent + marker.length + (gap > 4 ? 1 : gap);
    return {
      indent,
      ordered,
      start: ordered ? Number.parseInt(marker, 10) : 1,
      contentIndent,
      text: gap > 4 ? ' '.repeat(gap - 1) + (m[4] ?? '') : (m[4] ?? ''),
    };
  }
  const e = LIST_EMPTY_RE.exec(line);
  if (e !== null) {
    const indent = e[1]?.length ?? 0;
    const marker = e[2] ?? '-';
    const ordered = /\d/.test(marker);
    return {
      indent,
      ordered,
      start: ordered ? Number.parseInt(marker, 10) : 1,
      contentIndent: indent + marker.length + 1,
      text: '',
    };
  }
  return null;
};

/** A line that opens a new block and therefore ends a paragraph or a lazy list continuation. */
const startsBlock = (line: string, next: string | undefined): boolean =>
  FENCE_RE.test(line) ||
  HEADING_RE.test(line) ||
  RULE_RE.test(line) ||
  QUOTE_RE.test(line) ||
  listLine(line) !== null ||
  isTableStart(line, next);

const isTableStart = (line: string, next: string | undefined): boolean =>
  next !== undefined && line.includes('|') && TABLE_DELIM_RE.test(next) && next.includes('-');

const stripIndent = (line: string, columns: number): string => {
  let i = 0;
  while (i < columns && i < line.length && line[i] === ' ') i += 1;
  return line.slice(i);
};

const leadingSpaces = (line: string): number => line.length - line.trimStart().length;

const splitCells = (row: string): string[] => {
  const cells: string[] = [];
  let cur = '';
  let i = 0;
  const trimmed = row.trim();
  const body = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const inner = body.endsWith('|') && !body.endsWith('\\|') ? body.slice(0, -1) : body;
  while (i < inner.length) {
    const ch = inner[i] ?? '';
    if (ch === '\\' && inner[i + 1] === '|') {
      cur += '|';
      i += 2;
      continue;
    }
    if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  cells.push(cur.trim());
  return cells;
};

const cellAlign = (spec: string): Align => {
  const s = spec.trim();
  const left = s.startsWith(':');
  const right = s.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
};

/** Parses markdown text into blocks. Never throws; unknown syntax stays literal. */
export const parseMarkdown = (text: string): Block[] => parseBlocks(text.replace(/\r\n?/g, '\n').split('\n'));

const parseBlocks = (lines: string[]): Block[] => {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (isBlank(line)) {
      i += 1;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence !== null) {
      const marker = fence[1] ?? '```';
      const lang = fence[2] ?? '';
      const body: string[] = [];
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        const l = lines[j] ?? '';
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l);
        if (close !== null) {
          const m = close[1] ?? '';
          if (m[0] === marker[0] && m.length >= marker.length) {
            closed = true;
            j += 1;
            break;
          }
        }
        body.push(l);
        j += 1;
      }
      out.push({ kind: 'code', lang: lang === '' ? null : lang, text: body.join('\n'), open: !closed });
      i = j;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      const n = heading[1]?.length ?? 1;
      const level = (n >= 3 ? 3 : n) as 1 | 2 | 3;
      out.push({ kind: 'heading', level, children: parseInline(heading[2] ?? '') });
      i += 1;
      continue;
    }

    if (RULE_RE.test(line)) {
      out.push({ kind: 'rule' });
      i += 1;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? '';
        const q = QUOTE_RE.exec(l);
        if (q === null) break;
        inner.push(q[1] ?? '');
        i += 1;
      }
      out.push({ kind: 'quote', children: parseBlocks(inner) });
      continue;
    }

    if (isTableStart(line, lines[i + 1])) {
      const header = splitCells(line).map(parseInline);
      const align = splitCells(lines[i + 1] ?? '').map(cellAlign);
      const rows: Inline[][][] = [];
      let j = i + 2;
      while (j < lines.length) {
        const l = lines[j] ?? '';
        if (isBlank(l) || !l.includes('|')) break;
        const cells = splitCells(l).map(parseInline);
        while (cells.length < header.length) cells.push([]);
        rows.push(cells.slice(0, header.length));
        j += 1;
      }
      out.push({ kind: 'table', align, header, rows });
      i = j;
      continue;
    }

    const first = listLine(line);
    if (first !== null) {
      const items: ListItem[] = [];
      const baseIndent = first.indent;
      const ordered = first.ordered;
      let itemLines: string[] | null = null;
      let contentIndent = first.contentIndent;
      let sawBlank = false;
      const flush = () => {
        if (itemLines !== null) items.push({ children: parseBlocks(itemLines) });
        itemLines = null;
      };
      while (i < lines.length) {
        const l = lines[i] ?? '';
        if (isBlank(l)) {
          if (itemLines === null) break;
          sawBlank = true;
          itemLines.push('');
          i += 1;
          continue;
        }
        const ll = listLine(l);
        const indent = leadingSpaces(l);
        if (ll !== null && ll.indent <= baseIndent && indent < contentIndent) {
          if (ll.ordered !== ordered) break;
          flush();
          itemLines = [ll.text];
          contentIndent = ll.contentIndent;
          sawBlank = false;
          i += 1;
          continue;
        }
        if (itemLines === null) break;
        if (indent >= contentIndent || (indent > baseIndent && ll !== null)) {
          itemLines.push(stripIndent(l, contentIndent));
          sawBlank = false;
          i += 1;
          continue;
        }
        // Lazy continuation: an unindented plain line right after item text keeps the item's paragraph going.
        if (!sawBlank && !startsBlock(l, lines[i + 1])) {
          itemLines.push(l.trimStart());
          i += 1;
          continue;
        }
        break;
      }
      flush();
      out.push({ kind: 'list', ordered, start: first.start, items });
      continue;
    }

    const para: string[] = [line];
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j] ?? '';
      if (isBlank(l) || startsBlock(l, lines[j + 1])) break;
      para.push(l);
      j += 1;
    }
    out.push({ kind: 'paragraph', children: parseInline(para.join('\n')) });
    i = j;
  }
  return out;
};

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}_]/u.test(c);
const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c);

const URL_RE = /^https?:\/\/[^\s<>()[\]]+/;
const SAFE_HREF_RE = /^https?:\/\//i;

const trimUrl = (raw: string): string => {
  let url = raw;
  while (url.length > 0 && /[.,;:!?'"]$/.test(url)) url = url.slice(0, -1);
  return url;
};

/** Parses inline markdown: code spans, strong, emphasis, links, autolinks, escapes and hard breaks. */
export const parseInline = (src: string): Inline[] => {
  const out: Inline[] = [];
  let buf = '';
  const flushText = () => {
    if (buf !== '') {
      out.push({ kind: 'text', text: buf });
      buf = '';
    }
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i] ?? '';

    if (ch === '\\' && i + 1 < src.length) {
      const next = src[i + 1] ?? '';
      if (next === '\n') {
        flushText();
        out.push({ kind: 'break' });
        i += 2;
        continue;
      }
      if (/[\\`*_{}[\]()#+\-.!|>~<]/.test(next)) {
        buf += next;
        i += 2;
        continue;
      }
    }

    if (ch === '\n') {
      flushText();
      out.push({ kind: 'break' });
      i += 1;
      continue;
    }

    if (ch === '`') {
      let n = 0;
      while (src[i + n] === '`') n += 1;
      const ticks = '`'.repeat(n);
      const close = src.indexOf(ticks, i + n);
      if (close !== -1) {
        let code = src.slice(i + n, close).replace(/\n/g, ' ');
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') {
          code = code.slice(1, -1);
        }
        flushText();
        out.push({ kind: 'code', text: code });
        i = close + n;
        continue;
      }
      buf += ticks;
      i += n;
      continue;
    }

    if ((ch === '*' || ch === '_') && src[i + 1] === ch) {
      const closeAt = findClose(src, ch + ch, i + 2, ch);
      if (closeAt !== -1) {
        flushText();
        out.push({ kind: 'strong', children: parseInline(src.slice(i + 2, closeAt)) });
        i = closeAt + 2;
        continue;
      }
    }

    if (ch === '*' || ch === '_') {
      const before = i === 0 ? undefined : src[i - 1];
      const after = src[i + 1];
      const canOpen = !isSpace(after) && (ch === '*' || !isWordChar(before));
      if (canOpen) {
        const closeAt = findClose(src, ch, i + 1, ch);
        if (closeAt !== -1) {
          flushText();
          out.push({ kind: 'em', children: parseInline(src.slice(i + 1, closeAt)) });
          i = closeAt + 1;
          continue;
        }
      }
    }

    if (ch === '[') {
      const link = parseLink(src, i);
      if (link !== null) {
        flushText();
        out.push(link.node);
        i = link.end;
        continue;
      }
    }

    if (ch === '<') {
      const end = src.indexOf('>', i + 1);
      if (end !== -1) {
        const inner = src.slice(i + 1, end);
        if (SAFE_HREF_RE.test(inner) && !/\s/.test(inner)) {
          flushText();
          out.push({ kind: 'link', href: inner, children: [{ kind: 'text', text: inner }] });
          i = end + 1;
          continue;
        }
      }
    }

    if (ch === 'h' && (i === 0 || !isWordChar(src[i - 1]))) {
      const m = URL_RE.exec(src.slice(i));
      if (m !== null) {
        const url = trimUrl(m[0]);
        flushText();
        out.push({ kind: 'link', href: url, children: [{ kind: 'text', text: url }] });
        i += url.length;
        continue;
      }
    }

    buf += ch;
    i += 1;
  }
  flushText();
  return mergeText(out);
};

/**
 * Finds the closing delimiter for emphasis: not preceded by whitespace, and for `_` not followed by a word
 * character (snake_case stays literal). Stops at a hard newline only for single-character delimiters.
 */
const findClose = (src: string, delim: string, from: number, ch: string): number => {
  let i = from;
  while (i < src.length) {
    const at = src.indexOf(delim, i);
    if (at === -1) return -1;
    if (at === from) {
      i = at + 1;
      continue;
    }
    let run = 0;
    while (src[at + run] === ch) run += 1;
    // A `***` run closes strong with its last two characters (the first closes the inner emphasis).
    const pos = delim.length === 2 && run >= 3 ? at + run - 2 : at;
    const before = src[pos - 1];
    const after = src[pos + delim.length];
    const ok = !isSpace(before) && (ch === '*' || !isWordChar(after));
    if (ok && (delim.length === 2 || after !== ch)) return pos;
    i = at + run;
  }
  return -1;
};

const parseLink = (src: string, start: number): { node: Inline; end: number } | null => {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '[') depth += 1;
    else if (c === ']') {
      depth -= 1;
      if (depth === 0) break;
    } else if (c === '\n') return null;
    i += 1;
  }
  if (i >= src.length || src[i + 1] !== '(') return null;
  const label = src.slice(start + 1, i);
  // Balanced parentheses inside the target (`https://x/a_(b)`) belong to the URL.
  let close = -1;
  let parens = 0;
  for (let k = i + 2; k < src.length; k += 1) {
    const c = src[k];
    if (c === '\\') {
      k += 1;
      continue;
    }
    if (c === '(') parens += 1;
    else if (c === ')') {
      if (parens === 0) {
        close = k;
        break;
      }
      parens -= 1;
    } else if (c === '\n') return null;
  }
  if (close === -1) return null;
  const target = src.slice(i + 2, close).trim();
  const href = target.split(/\s+/)[0] ?? '';
  const unwrapped = href.startsWith('<') && href.endsWith('>') ? href.slice(1, -1) : href;
  if (!SAFE_HREF_RE.test(unwrapped)) {
    return { node: { kind: 'text', text: label }, end: close + 1 };
  }
  return { node: { kind: 'link', href: unwrapped, children: parseInline(label) }, end: close + 1 };
};

const mergeText = (nodes: Inline[]): Inline[] => {
  const out: Inline[] = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (n.kind === 'text' && last !== undefined && last.kind === 'text') {
      out[out.length - 1] = { kind: 'text', text: last.text + n.text };
    } else {
      out.push(n);
    }
  }
  return out;
};

/** The plain text of an inline run (for tests and accessible names). */
export const inlineText = (nodes: readonly Inline[]): string =>
  nodes
    .map((n) => {
      switch (n.kind) {
        case 'text':
        case 'code':
          return n.text;
        case 'break':
          return '\n';
        default:
          return inlineText(n.children);
      }
    })
    .join('');

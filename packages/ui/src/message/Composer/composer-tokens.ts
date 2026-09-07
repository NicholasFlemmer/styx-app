/**
 * Caret-token detection for the composer's `@file` and `/command` popups (owner addition,
 * docs/handoff-discrepancies #57). Pure string helpers; the Composer owns the state.
 */

export type TokenKind = 'mention' | 'slash';

export interface CaretToken {
  kind: TokenKind;
  /** Text after the trigger character, up to the caret. */
  query: string;
  /** Index of the trigger character. */
  start: number;
  /** Caret position (exclusive end of the token). */
  end: number;
}

const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c);

/**
 * The token the caret sits in: `@…` anywhere after whitespace (file mention) or `/…` at the start of the
 * message (command). `null` when the caret is not inside such a token.
 */
export const tokenAtCaret = (text: string, caret: number): CaretToken | null => {
  const end = Math.max(0, Math.min(caret, text.length));
  let start = end;
  while (start > 0 && !isSpace(text[start - 1])) start -= 1;
  const token = text.slice(start, end);
  const trigger = token[0];
  if (trigger === '@') {
    return { kind: 'mention', query: token.slice(1), start, end };
  }
  if (trigger === '/' && text.slice(0, start).trim() === '') {
    return { kind: 'slash', query: token.slice(1), start, end };
  }
  return null;
};

/** Replaces the token with `replacement` plus a trailing space; returns the new text and caret. */
export const insertToken = (
  text: string,
  token: Pick<CaretToken, 'start' | 'end'>,
  replacement: string,
): { text: string; caret: number } => {
  const after = text.slice(token.end);
  const spaced = after.startsWith(' ');
  const next = text.slice(0, token.start) + replacement + (spaced ? '' : ' ') + after;
  // The caret always lands past the separating space, so typing continues on a fresh word.
  return { text: next, caret: token.start + replacement.length + 1 };
};

/** Files from a paste or drop event's DataTransfer (file items only). */
export const filesFrom = (data: DataTransfer | null): File[] => {
  if (data === null) return [];
  const out: File[] = [];
  if (data.items !== undefined && data.items.length > 0) {
    for (const item of Array.from(data.items)) {
      if (item.kind !== 'file') continue;
      const f = item.getAsFile();
      if (f !== null) out.push(f);
    }
    return out;
  }
  return Array.from(data.files ?? []);
};

/** Whether a drag carries files (as opposed to text). */
export const hasFiles = (data: DataTransfer | null): boolean =>
  data !== null && Array.from(data.types ?? []).includes('Files');

import { describe, expect, it } from 'vitest';
import { filesFrom, hasFiles, insertToken, tokenAtCaret } from './composer-tokens';

describe('tokenAtCaret', () => {
  const cases: { name: string; text: string; caret: number; out: ReturnType<typeof tokenAtCaret> }[] = [
    { name: 'empty', text: '', caret: 0, out: null },
    { name: 'plain word', text: 'hello', caret: 5, out: null },
    { name: '@ alone', text: '@', caret: 1, out: { kind: 'mention', query: '', start: 0, end: 1 } },
    {
      name: '@ with query',
      text: 'fix @src/ch',
      caret: 11,
      out: { kind: 'mention', query: 'src/ch', start: 4, end: 11 },
    },
    {
      name: '@ mid-token caret',
      text: 'fix @src/ch',
      caret: 8,
      out: { kind: 'mention', query: 'src', start: 4, end: 8 },
    },
    { name: '@ after the token (space typed)', text: '@a.ts ', caret: 6, out: null },
    { name: 'email-like @ inside a word is not a mention', text: 'me@x', caret: 4, out: null },
    {
      name: '/ at the start',
      text: '/comp',
      caret: 5,
      out: { kind: 'slash', query: 'comp', start: 0, end: 5 },
    },
    {
      name: '/ after leading spaces',
      text: '  /c',
      caret: 4,
      out: { kind: 'slash', query: 'c', start: 2, end: 4 },
    },
    { name: '/ later in the message is not a command', text: 'run /compact', caret: 12, out: null },
    {
      name: 'caret clamped to the text',
      text: '@a',
      caret: 99,
      out: { kind: 'mention', query: 'a', start: 0, end: 2 },
    },
    {
      name: 'newline separates tokens',
      text: 'x\n@b',
      caret: 4,
      out: { kind: 'mention', query: 'b', start: 2, end: 4 },
    },
  ];
  it.each(cases)('$name', ({ text, caret, out }) => {
    expect(tokenAtCaret(text, caret)).toEqual(out);
  });
});

describe('insertToken', () => {
  it('replaces the token with the replacement and a trailing space', () => {
    expect(insertToken('fix @src/ch now', { start: 4, end: 11 }, '@src/checkout.ts')).toEqual({
      text: 'fix @src/checkout.ts now',
      caret: 21,
    });
  });
  it('does not double a space that already follows', () => {
    expect(insertToken('/co', { start: 0, end: 3 }, '/compact')).toEqual({ text: '/compact ', caret: 9 });
    expect(insertToken('@a b', { start: 0, end: 2 }, '@a.ts')).toEqual({ text: '@a.ts b', caret: 6 });
  });
});

describe('filesFrom / hasFiles', () => {
  const file = new File(['x'], 'a.png', { type: 'image/png' });
  it('reads file items and ignores strings', () => {
    const data = {
      items: [
        { kind: 'string', getAsFile: () => null },
        { kind: 'file', getAsFile: () => file },
      ],
      files: [],
      types: ['Files', 'text/plain'],
    } as unknown as DataTransfer;
    expect(filesFrom(data)).toEqual([file]);
    expect(hasFiles(data)).toBe(true);
  });
  it('falls back to the files list and handles null', () => {
    const data = { items: [], files: [file], types: ['Files'] } as unknown as DataTransfer;
    expect(filesFrom(data)).toEqual([file]);
    expect(filesFrom(null)).toEqual([]);
    expect(hasFiles(null)).toBe(false);
    expect(hasFiles({ types: ['text/plain'] } as unknown as DataTransfer)).toBe(false);
  });
});

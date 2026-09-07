import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_FILE_ATTACHMENT_BYTES, MAX_IMAGE_BYTES } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { attachmentName, inlineFiles, prepareAttachments } from './message-attachments';

const setup = () => {
  const base = mkdtempSync(join(tmpdir(), 'styx-msg-attach-'));
  const root = join(base, 'wt');
  const outside = join(base, 'outside');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, 'src', 'a.ts'), 'const a = 1;\n');
  writeFileSync(join(root, 'notes.md'), 'hello');
  writeFileSync(join(root, 'big.txt'), 'x'.repeat(MAX_FILE_ATTACHMENT_BYTES + 1));
  writeFileSync(join(root, 'max.txt'), 'y'.repeat(MAX_FILE_ATTACHMENT_BYTES));
  writeFileSync(join(outside, 'secret.txt'), 'nope');
  symlinkSync(outside, join(root, 'escape'));
  symlinkSync(join(outside, 'secret.txt'), join(root, 'escape.txt'));
  return { root, outside };
};

const png = {
  kind: 'image' as const,
  name: 'shot.png',
  mediaType: 'image/png' as const,
  data: 'iVBORw0KGgo=',
};

describe('prepareAttachments', () => {
  it('images: base64 decoded for the size, metadata for the row, a base64 block for the turn', async () => {
    const { root } = setup();
    const r = await prepareAttachments(root, [png, { ...png, name: 'b.webp', mediaType: 'image/webp' }]);
    expect(r.meta).toEqual([
      { kind: 'image', name: 'shot.png', mediaType: 'image/png', bytes: 8 },
      { kind: 'image', name: 'b.webp', mediaType: 'image/webp', bytes: 8 },
    ]);
    expect(r.images).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.data } },
      { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: png.data } },
    ]);
    expect(r.files).toEqual([]);
  });

  it('files: confined to the worktree, regular files only, utf8, worktree-relative `/` paths', async () => {
    const { root } = setup();
    const r = await prepareAttachments(root, [
      { kind: 'file', path: 'src/a.ts' },
      { kind: 'file', path: './src/../notes.md' },
      { kind: 'file', path: join(root, 'max.txt') }, // absolute but inside
    ]);
    expect(r.meta).toEqual([
      { kind: 'file', path: 'src/a.ts', bytes: 13 },
      { kind: 'file', path: 'notes.md', bytes: 5 },
      { kind: 'file', path: 'max.txt', bytes: MAX_FILE_ATTACHMENT_BYTES },
    ]);
    expect(r.files.map((f) => f.path)).toEqual(['src/a.ts', 'notes.md', 'max.txt']);
    expect(r.files[0]?.text).toBe('const a = 1;\n');
    expect(r.images).toEqual([]);
  });

  it.each([
    ['image at the cap passes', [{ ...png, data: Buffer.alloc(MAX_IMAGE_BYTES).toString('base64') }], null],
    [
      'image over the cap',
      [{ ...png, data: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64') }],
      { code: 'invalid-input', message: 'shot.png is larger than 5 MB' },
    ],
    ['image that decodes to nothing', [{ ...png, data: '=' }], { code: 'invalid-input', message: /empty/ }],
    [
      'file over the cap',
      [{ kind: 'file' as const, path: 'big.txt' }],
      { code: 'invalid-input', message: 'big.txt is larger than 200 KB' },
    ],
    [
      'parent escape',
      [{ kind: 'file' as const, path: '../outside/secret.txt' }],
      { code: 'fs-denied', message: /outside the worktree/ },
    ],
    [
      'absolute outside',
      [{ kind: 'file' as const, path: '/etc/passwd' }],
      { code: 'fs-denied', message: /outside the worktree/ },
    ],
    [
      'symlinked directory escape',
      [{ kind: 'file' as const, path: 'escape/secret.txt' }],
      { code: 'fs-denied', message: /outside the worktree/ },
    ],
    [
      'symlinked file escape',
      [{ kind: 'file' as const, path: 'escape.txt' }],
      { code: 'fs-denied', message: /outside the worktree/ },
    ],
    [
      'a directory',
      [{ kind: 'file' as const, path: 'src' }],
      { code: 'invalid-input', message: /src is not a file/ },
    ],
    [
      'the worktree root',
      [{ kind: 'file' as const, path: '.' }],
      { code: 'invalid-input', message: /not a file/ },
    ],
    [
      'a missing file',
      [{ kind: 'file' as const, path: 'src/zzz.ts' }],
      { code: 'invalid-input', message: /src\/zzz\.ts is not a file/ },
    ],
  ])('%s', async (_label, attachments, error) => {
    const { root } = setup();
    const p = prepareAttachments(root, attachments);
    if (error === null) await expect(p).resolves.toBeDefined();
    else await expect(p).rejects.toMatchObject(error);
  });
});

describe('inlineFiles / attachmentName', () => {
  it('appends one <file> section per file after the text, in order; no files → the text alone', () => {
    expect(inlineFiles('hi', [])).toBe('hi');
    expect(inlineFiles('', [{ path: 'a.md', text: 'one' }])).toBe('\n\n<file path="a.md">\none\n</file>');
    expect(
      inlineFiles('review these', [
        { path: 'src/a.ts', text: 'const a = 1;\n' },
        { path: 'b.txt', text: 'b' },
      ]),
    ).toBe(
      'review these\n\n<file path="src/a.ts">\nconst a = 1;\n\n</file>\n\n<file path="b.txt">\nb\n</file>',
    );
  });

  it('names an image by its name and a file by its path', () => {
    expect(attachmentName({ kind: 'image', name: 'shot.png', mediaType: 'image/png', bytes: 1 })).toBe(
      'shot.png',
    );
    expect(attachmentName({ kind: 'file', path: 'src/a.ts', bytes: 1 })).toBe('src/a.ts');
  });
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  ATTACHMENTS_DIR,
  MAX_FILE_ATTACHMENT_BYTES,
  MAX_IMAGE_BYTES,
  MAX_MESSAGE_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
} from '@styx/core';
import { describe, expect, it } from 'vitest';
import {
  attachmentName,
  composeTurn,
  humanSize,
  mediaTypeOf,
  prepareAttachments,
  safeName,
  type PrepareOptions,
} from './message-attachments';

const setup = (git = false) => {
  const base = mkdtempSync(join(tmpdir(), 'styx-msg-attach-'));
  const root = join(base, 'wt');
  const outside = join(base, 'outside');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(outside);
  if (git) execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, 'src', 'a.ts'), 'const a = 1;\n');
  writeFileSync(join(root, 'notes.md'), 'hello');
  writeFileSync(join(root, 'big.txt'), 'x'.repeat(MAX_FILE_ATTACHMENT_BYTES + 1));
  writeFileSync(join(root, 'max.txt'), 'y'.repeat(MAX_FILE_ATTACHMENT_BYTES));
  writeFileSync(join(root, 'blob.bin'), Buffer.from([1, 0, 2, 3]));
  writeFileSync(join(root, 'shot.png'), Buffer.from('png'));
  writeFileSync(join(root, '.env'), 'TOKEN=1');
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
const upload = (name: string, content: Buffer | string, mediaType = '') => ({
  kind: 'upload' as const,
  name,
  mediaType,
  data: Buffer.from(content).toString('base64'),
});
const claude: PrepareOptions = { sessionId: 's1', imageBlocks: true };
const terminal: PrepareOptions = { sessionId: 's1', imageBlocks: false };

describe('prepareAttachments', () => {
  it('images the agent takes inline: base64 decoded for the size, metadata for the row, a block for the turn, nothing saved', async () => {
    const { root } = setup();
    const r = await prepareAttachments(
      root,
      [png, { ...png, name: 'b.webp', mediaType: 'image/webp' }],
      claude,
    );
    expect(r.meta).toEqual([
      { kind: 'image', name: 'shot.png', mediaType: 'image/png', bytes: 8 },
      { kind: 'image', name: 'b.webp', mediaType: 'image/webp', bytes: 8 },
    ]);
    expect(r.images).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.data } },
      { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: png.data } },
    ]);
    expect(r.files).toEqual([]);
    expect(r.refs).toEqual([]);
    expect(existsSync(join(root, ATTACHMENTS_DIR))).toBe(false);
  });

  it('an agent that cannot take images (a terminal, a text-only runner) gets the image saved in the worktree and its path', async () => {
    const { root } = setup(true);
    const r = await prepareAttachments(root, [png], terminal);
    expect(r.images).toEqual([]);
    expect(r.refs).toHaveLength(1);
    const ref = r.refs[0]!;
    expect(ref).toMatchObject({ name: 'shot.png', mediaType: 'image/png', bytes: 8 });
    expect(ref.path.startsWith(join(root, ATTACHMENTS_DIR, 's1'))).toBe(true);
    expect(readFileSync(ref.path).toString('base64')).toBe(png.data);
    expect(r.meta).toEqual([
      expect.objectContaining({ kind: 'image', name: 'shot.png', mediaType: 'image/png', bytes: 8 }),
    ]);
    // The folder is excluded from git locally: nothing attached is ever committed or shown as a change.
    expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')).toContain(`${ATTACHMENTS_DIR}/`);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).not.toContain(
      '.styx',
    );
  });

  it('any other file: small text is inlined under its own name; a PDF, a binary or a big file is saved and referenced', async () => {
    const { root } = setup();
    const r = await prepareAttachments(
      root,
      [
        upload('notes from call.txt', 'ship friday\n', 'text/plain'),
        upload('spec.pdf', Buffer.from('%PDF-1.7\n\u0000binary'), 'application/pdf'),
        upload('clip.mov', Buffer.alloc(300 * 1024, 1)),
        upload('huge.log', 'z'.repeat(MAX_FILE_ATTACHMENT_BYTES + 1)),
      ],
      claude,
    );
    expect(r.files).toEqual([{ path: 'notes from call.txt', text: 'ship friday\n' }]);
    expect(r.refs.map((f) => [f.name, f.mediaType])).toEqual([
      ['spec.pdf', 'application/pdf'],
      ['clip.mov', 'video/quicktime'],
      ['huge.log', ''],
    ]);
    for (const f of r.refs) expect(existsSync(f.path)).toBe(true);
    expect(
      r.meta.map((m) => (m.kind === 'file' ? [m.name, m.path.startsWith(`${ATTACHMENTS_DIR}/s1/`)] : m.kind)),
    ).toEqual([
      ['notes from call.txt', true],
      ['spec.pdf', true],
      ['clip.mov', true],
      ['huge.log', true],
    ]);
  });

  it('worktree files (`@`): confined, regular files only; text inlined by path, binaries and big files referenced, images as blocks', async () => {
    const { root } = setup();
    const r = await prepareAttachments(
      root,
      [
        { kind: 'file', path: 'src/a.ts' },
        { kind: 'file', path: './src/../notes.md' },
        { kind: 'file', path: join(root, 'max.txt') }, // absolute but inside
        { kind: 'file', path: 'big.txt' },
        { kind: 'file', path: 'blob.bin' },
        { kind: 'file', path: 'shot.png' },
      ],
      claude,
    );
    expect(r.files.map((f) => f.path)).toEqual(['src/a.ts', 'notes.md', 'max.txt']);
    expect(r.files[0]?.text).toBe('const a = 1;\n');
    expect(r.refs.map((f) => [f.path, f.name])).toEqual([
      [join(root, 'big.txt'), 'big.txt'],
      [join(root, 'blob.bin'), 'blob.bin'],
    ]);
    expect(r.images).toEqual([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: Buffer.from('png').toString('base64') },
      },
    ]);
    expect(r.meta).toEqual([
      { kind: 'file', path: 'src/a.ts', bytes: 13 },
      { kind: 'file', path: 'notes.md', bytes: 5, mediaType: 'text/markdown' },
      { kind: 'file', path: 'max.txt', bytes: MAX_FILE_ATTACHMENT_BYTES, mediaType: 'text/plain' },
      { kind: 'file', path: 'big.txt', bytes: MAX_FILE_ATTACHMENT_BYTES + 1, mediaType: 'text/plain' },
      { kind: 'file', path: 'blob.bin', bytes: 4 },
      { kind: 'image', name: 'shot.png', mediaType: 'image/png', bytes: 3, path: 'shot.png' },
    ]);
  });

  it('a held (queued) message saves what was attached and keeps paths only; nothing is read until it goes out', async () => {
    const { root } = setup();
    const r = await prepareAttachments(
      root,
      [png, upload('spec.pdf', 'x', 'application/pdf'), { kind: 'file', path: 'src/a.ts' }],
      { ...claude, hold: true },
    );
    expect(r.images).toEqual([]);
    expect(r.files).toEqual([]);
    expect(r.refs).toEqual([]);
    expect(r.held).toHaveLength(3);
    expect(r.held[0]).toMatch(new RegExp(`^${ATTACHMENTS_DIR}/s1/[0-9a-f]+/shot\\.png$`));
    expect(r.held[1]).toMatch(new RegExp(`^${ATTACHMENTS_DIR}/s1/[0-9a-f]+/spec\\.pdf$`));
    expect(r.held[2]).toBe('src/a.ts');
    // Sent later: the saved image is an image block again, named as it was attached.
    const later = await prepareAttachments(
      root,
      r.held.map((path) => ({ kind: 'file' as const, path })),
      claude,
    );
    expect(later.images).toHaveLength(1);
    expect(later.meta.map((m) => attachmentName(m))).toEqual(['shot.png', 'spec.pdf', 'src/a.ts']);
    expect(later.files.map((f) => f.path)).toEqual(['spec.pdf', 'src/a.ts']);
  });

  it.each([
    [
      'image at the inline cap passes',
      [{ ...png, data: Buffer.alloc(MAX_IMAGE_BYTES).toString('base64') }],
      null,
    ],
    [
      'an image over the inline cap is saved and referenced',
      [{ ...png, data: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64') }],
      null,
    ],
    [
      'image that decodes to nothing',
      [{ ...png, data: '=' }],
      { code: 'invalid-input', message: 'shot.png is empty' },
    ],
    [
      'an attached file over 25 MB',
      [upload('movie.mp4', Buffer.alloc(MAX_UPLOAD_BYTES + 1))],
      { code: 'invalid-input', message: 'movie.mp4 is larger than 25 MB' },
    ],
    [
      'more than 50 MB in one message',
      [
        upload('a.bin', Buffer.alloc(MAX_UPLOAD_BYTES)),
        upload('b.bin', Buffer.alloc(MAX_UPLOAD_BYTES)),
        upload('c.bin', Buffer.alloc(1024)),
      ],
      {
        code: 'invalid-input',
        message: `Attachments are limited to ${humanSize(MAX_MESSAGE_UPLOAD_BYTES)} per message`,
      },
    ],
    [
      'an attached key file',
      [upload('id_rsa', 'key')],
      { code: 'invalid-input', message: /id_rsa looks like a key or credentials file/ },
    ],
    [
      'a worktree .env',
      [{ kind: 'file' as const, path: '.env' }],
      { code: 'invalid-input', message: /\.env looks like a key or credentials file/ },
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
    const p = prepareAttachments(root, attachments, claude);
    if (error === null) await expect(p).resolves.toBeDefined();
    else await expect(p).rejects.toMatchObject(error);
  });
});

describe('composeTurn / attachmentName / safeName / mediaTypeOf', () => {
  it('appends one <file> section per inlined file, then the saved files by absolute path; nothing attached → the text alone', () => {
    expect(composeTurn('hi', { files: [], refs: [] })).toBe('hi');
    expect(composeTurn('', { files: [{ path: 'a.md', text: 'one' }], refs: [] })).toBe(
      '\n\n<file path="a.md">\none\n</file>',
    );
    expect(
      composeTurn('review these', {
        files: [{ path: 'src/a.ts', text: 'const a = 1;\n' }],
        refs: [
          {
            path: '/wt/.styx/attachments/s1/ab/spec.pdf',
            name: 'spec.pdf',
            mediaType: 'application/pdf',
            bytes: 2 * 1024 * 1024,
          },
          { path: '/wt/blob.bin', name: 'blob.bin', mediaType: '', bytes: 512 },
        ],
      }),
    ).toBe(
      'review these\n\n<file path="src/a.ts">\nconst a = 1;\n\n</file>\n\n' +
        'Attached with this message, saved in your worktree — open them with your file tools:\n' +
        '- /wt/.styx/attachments/s1/ab/spec.pdf (application/pdf, 2 MB)\n' +
        '- /wt/blob.bin (512 B)',
    );
  });

  it('names an image by its name, an attached file by what was attached, a worktree file by its path', () => {
    expect(attachmentName({ kind: 'image', name: 'shot.png', mediaType: 'image/png', bytes: 1 })).toBe(
      'shot.png',
    );
    expect(attachmentName({ kind: 'file', path: 'src/a.ts', bytes: 1 })).toBe('src/a.ts');
    expect(
      attachmentName({ kind: 'file', path: '.styx/attachments/s/x/spec.pdf', name: 'spec.pdf', bytes: 1 }),
    ).toBe('spec.pdf');
  });

  it.each([
    ['report.pdf', 'report.pdf'],
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\me\\notes.txt', 'notes.txt'],
    ['.hidden', 'hidden'],
    ['a<b>:c|d?.txt', 'a-b--c-d-.txt'],
    ['', 'attachment'],
    [`${'x'.repeat(200)}.tar.gz`, `${'x'.repeat(117)}.gz`],
  ])('safeName(%j) → %j', (input, expected) => {
    expect(safeName(input)).toBe(expected);
  });

  it('knows common media types by extension, and says nothing for the rest', () => {
    expect(mediaTypeOf('a.PDF')).toBe('application/pdf');
    expect(mediaTypeOf('x/y.heic')).toBe('image/heic');
    expect(mediaTypeOf('notes')).toBe('');
  });
});

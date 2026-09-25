// @vitest-environment jsdom
import { copy, fill } from '@styx/core';
import { describe, expect, it } from 'vitest';
import {
  composerChips,
  isAttachError,
  maxMessageLabel,
  maxUploadLabel,
  messageChips,
  pendingBytes,
  readAttachment,
  sendAttachments,
  withMention,
  type Pending,
} from './chat-attachments';

const image: Pending = {
  id: 'i1',
  kind: 'image',
  name: 'shot.png',
  mediaType: 'image/png',
  data: 'AAA',
  bytes: 3,
};
const file: Pending = { id: 'file:src/a.ts', kind: 'file', path: 'src/a.ts' };
const upload: Pending = {
  id: 'u1',
  kind: 'upload',
  name: 'spec.pdf',
  mediaType: 'application/pdf',
  data: 'JVBERg==',
  bytes: 40,
};

describe('chips', () => {
  it('composer chips carry the kind label and a filled remove label; an attached file reads as a file', () => {
    expect(composerChips([image, file, upload])).toEqual([
      {
        id: 'i1',
        label: 'shot.png',
        kind: 'image',
        kindLabel: copy.chat.attach.image,
        removeLabel: fill(copy.chat.attach.remove, { name: 'shot.png' }),
      },
      {
        id: 'file:src/a.ts',
        label: 'src/a.ts',
        kind: 'file',
        kindLabel: copy.chat.attach.file,
        removeLabel: fill(copy.chat.attach.remove, { name: 'src/a.ts' }),
      },
      {
        id: 'u1',
        label: 'spec.pdf',
        kind: 'file',
        kindLabel: copy.chat.attach.file,
        removeLabel: fill(copy.chat.attach.remove, { name: 'spec.pdf' }),
      },
    ]);
  });

  it('sent-message chips read the transcript payload', () => {
    expect(
      messageChips([
        { kind: 'image', name: 'a.png', mediaType: 'image/png', bytes: 10 },
        { kind: 'file', path: 'src/b.ts', bytes: 20 },
        { kind: 'file', path: '.styx/attachments/s/ab/spec.pdf', name: 'spec.pdf', bytes: 20 },
      ]),
    ).toEqual([
      { label: 'a.png', kind: 'image' },
      { label: 'src/b.ts', kind: 'file' },
      { label: 'spec.pdf', kind: 'file' },
    ]);
  });
});

describe('sendAttachments', () => {
  it('images and attached files carry base64 data, worktree files only their path', () => {
    expect(sendAttachments([image, file, upload])).toEqual([
      { kind: 'image', name: 'shot.png', mediaType: 'image/png', data: 'AAA' },
      { kind: 'file', path: 'src/a.ts' },
      { kind: 'upload', name: 'spec.pdf', mediaType: 'application/pdf', data: 'JVBERg==' },
    ]);
  });
});

describe('withMention', () => {
  it('adds a file attachment once per path', () => {
    const once = withMention([], 'src/a.ts');
    expect(once).toEqual([file]);
    expect(withMention(once, 'src/a.ts')).toEqual(once);
  });
});

describe('readAttachment', () => {
  const asFile = (name: string, type: string, size: number, content: string = 'x'): File => {
    const f = new File([content], name, { type });
    Object.defineProperty(f, 'size', { value: size });
    return f;
  };

  it('an image the agents take inline is an image; any other file is an upload', async () => {
    const img = await readAttachment(asFile('ok.png', 'image/png', 1), 'id-1');
    expect(img).toMatchObject({
      id: 'id-1',
      kind: 'image',
      name: 'ok.png',
      mediaType: 'image/png',
      bytes: 1,
    });
    if (isAttachError(img) || img.kind === 'file') throw new Error('expected an image');
    expect(img.data).not.toContain('data:');
    const pdf = await readAttachment(asFile('a.pdf', 'application/pdf', 10), 'id-2');
    expect(pdf).toMatchObject({ kind: 'upload', name: 'a.pdf', mediaType: 'application/pdf', bytes: 10 });
    // A 6 MB png is too big to go inline: it goes as a file (main saves it, the agent opens it by path).
    const big = await readAttachment(asFile('big.png', 'image/png', 6 * 1024 * 1024), 'id-3');
    expect(big).toMatchObject({ kind: 'upload', name: 'big.png' });
    const heic = await readAttachment(asFile('photo.heic', 'image/heic', 10), 'id-4');
    expect(heic).toMatchObject({ kind: 'upload' });
  });

  it.each([
    [
      'a file over 25 MB',
      asFileArgs('movie.mp4', 'video/mp4', 26 * 1024 * 1024),
      0,
      () => fill(copy.chat.attach.tooLarge, { name: 'movie.mp4', max: maxUploadLabel }),
    ],
    [
      'past 50 MB with what is already pending',
      asFileArgs('b.zip', 'application/zip', 10 * 1024 * 1024),
      45 * 1024 * 1024,
      () => fill(copy.chat.attach.total, { max: maxMessageLabel }),
    ],
    ['a key file', asFileArgs('id_rsa', '', 10), 0, () => fill(copy.chat.attach.secret, { name: 'id_rsa' })],
    [
      'a .env',
      asFileArgs('.env.production', '', 10),
      0,
      () => fill(copy.chat.attach.secret, { name: '.env.production' }),
    ],
    [
      'an empty file',
      asFileArgs('empty.txt', 'text/plain', 0, ''),
      0,
      () => fill(copy.chat.attach.empty, { name: 'empty.txt' }),
    ],
  ])('refuses %s with a line saying why', async (_label, args, pending, message) => {
    const [name, type, size, content] = args;
    const f = new File([content], name, { type });
    Object.defineProperty(f, 'size', { value: size });
    const r = await readAttachment(f, 'x', pending);
    expect(isAttachError(r) && r.message).toBe(message());
  });
});

function asFileArgs(
  name: string,
  type: string,
  size: number,
  content = 'x',
): [string, string, number, string] {
  return [name, type, size, content];
}

describe('pendingBytes', () => {
  it('counts what crosses to main (images and uploads), not `@` files', () => {
    expect(pendingBytes([image, file, upload])).toBe(3 + 40);
  });
});

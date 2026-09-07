// @vitest-environment jsdom
import { copy, fill } from '@styx/core';
import { describe, expect, it } from 'vitest';
import {
  composerChips,
  isImageError,
  maxImageLabel,
  messageChips,
  readImage,
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

describe('chips', () => {
  it('composer chips carry the kind label and a filled remove label', () => {
    expect(composerChips([image, file])).toEqual([
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
    ]);
  });

  it('sent-message chips read the transcript payload', () => {
    expect(
      messageChips([
        { kind: 'image', name: 'a.png', mediaType: 'image/png', bytes: 10 },
        { kind: 'file', path: 'src/b.ts', bytes: 20 },
      ]),
    ).toEqual([
      { label: 'a.png', kind: 'image' },
      { label: 'src/b.ts', kind: 'file' },
    ]);
  });
});

describe('sendAttachments', () => {
  it('images carry base64 data, files only their path', () => {
    expect(sendAttachments([image, file])).toEqual([
      { kind: 'image', name: 'shot.png', mediaType: 'image/png', data: 'AAA' },
      { kind: 'file', path: 'src/a.ts' },
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

describe('readImage', () => {
  const asFile = (name: string, type: string, size: number): File => {
    const f = new File([new Uint8Array(1)], name, { type });
    Object.defineProperty(f, 'size', { value: size });
    return f;
  };

  it('rejects a non-image with the unsupported copy', async () => {
    const r = await readImage(asFile('a.pdf', 'application/pdf', 10), 'x');
    expect(isImageError(r) && r.message).toBe(fill(copy.chat.attach.unsupported, { name: 'a.pdf' }));
  });

  it('rejects an oversized image with the size copy', async () => {
    const r = await readImage(asFile('big.png', 'image/png', 6 * 1024 * 1024), 'x');
    expect(isImageError(r) && r.message).toBe(
      fill(copy.chat.attach.tooLarge, { name: 'big.png', max: maxImageLabel }),
    );
  });

  it('reads an accepted image to base64 without the data: prefix', async () => {
    const r = await readImage(asFile('ok.png', 'image/png', 1), 'id-1');
    expect(isImageError(r)).toBe(false);
    if (isImageError(r)) return;
    expect(r).toMatchObject({ id: 'id-1', kind: 'image', name: 'ok.png', mediaType: 'image/png' });
    if (r.kind !== 'image') throw new Error('expected an image');
    expect(r.data).not.toContain('data:');
    expect(r.data.length).toBeGreaterThan(0);
  });
});

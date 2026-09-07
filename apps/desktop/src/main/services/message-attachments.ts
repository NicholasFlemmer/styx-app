import { readFile, stat } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import {
  MAX_FILE_ATTACHMENT_BYTES,
  MAX_IMAGE_BYTES,
  copy,
  fill,
  type Attachment,
  type CommandInput,
} from '@styx/core';
import { fail } from '../ipc/bus';
import { confine } from './confine';
import type { ImageBlock } from './stream-runner';

/** One attachment as the composer sends it: image bytes (base64) or a worktree-relative file path. */
export type AttachmentInput = NonNullable<CommandInput<'session.sendMessage'>['attachments']>[number];

/** A file attachment read by main: its worktree-relative path and utf8 contents (never logged). */
export interface InlinedFile {
  path: string;
  text: string;
}

export interface PreparedAttachments {
  /** Metadata for the transcript row (names, types, sizes — never the bytes). */
  meta: Attachment[];
  /** Base64 image blocks for a stream session's user turn. */
  images: ImageBlock[];
  files: InlinedFile[];
}

const humanSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.round(bytes / 1024)} KB`;

const tooLarge = (name: string, max: number): never =>
  fail('invalid-input', fill(copy.chat.attach.tooLarge, { name, max: humanSize(max) }));

/**
 * Validates and reads the attachments of one user message. Images must decode to at most MAX_IMAGE_BYTES; files
 * must resolve inside the worktree (same confinement as `fs.*`, symlinks included), be regular files of at most
 * MAX_FILE_ATTACHMENT_BYTES, and are read as utf8. Rejections are typed `invalid-input` / `fs-denied` failures.
 */
export async function prepareAttachments(
  worktreePath: string,
  attachments: readonly AttachmentInput[],
): Promise<PreparedAttachments> {
  const out: PreparedAttachments = { meta: [], images: [], files: [] };
  for (const a of attachments) {
    if (a.kind === 'image') {
      const bytes = Buffer.from(a.data, 'base64').length;
      if (bytes === 0) fail('invalid-input', `${a.name} is empty`);
      if (bytes > MAX_IMAGE_BYTES) tooLarge(a.name, MAX_IMAGE_BYTES);
      out.meta.push({ kind: 'image', name: a.name, mediaType: a.mediaType, bytes });
      out.images.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data } });
      continue;
    }
    const full = confine(worktreePath, a.path);
    const rel = relative(worktreePath, full).split(sep).join('/');
    const info = await stat(full).catch(() => null);
    if (info === null || !info.isFile())
      fail('invalid-input', `${rel || a.path} is not a file in the worktree`);
    if (info.size > MAX_FILE_ATTACHMENT_BYTES) tooLarge(rel, MAX_FILE_ATTACHMENT_BYTES);
    const text = await readFile(full, 'utf8');
    out.meta.push({ kind: 'file', path: rel, bytes: info.size });
    out.files.push({ path: rel, text });
  }
  return out;
}

/** The trailing `<file path="…">` section per attached file, after the typed text. */
export const inlineFiles = (body: string, files: readonly InlinedFile[]): string =>
  files.reduce((text, f) => `${text}\n\n<file path="${f.path}">\n${f.text}\n</file>`, body);

/** The chip label of an attachment (image name or file path); joined as the body of an attachment-only message. */
export const attachmentName = (a: Attachment): string => (a.kind === 'image' ? a.name : a.path);

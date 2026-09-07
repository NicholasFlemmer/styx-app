import {
  IMAGE_MEDIA_TYPES,
  MAX_IMAGE_BYTES,
  copy,
  fill,
  type CommandInput,
  type Attachment as CoreAttachment,
} from '@styx/core';
import type { ComposerAttachment, MessageAttachment } from '@styx/ui';

/** A pending attachment in the composer: an image read from a paste/drop, or an `@`-mentioned worktree file. */
export type Pending =
  | { id: string; kind: 'image'; name: string; mediaType: string; data: string; bytes: number }
  | { id: string; kind: 'file'; path: string };

const MB = 1024 * 1024;
export const maxImageLabel = `${Math.round(MAX_IMAGE_BYTES / MB)} MB`;

/** Chips for the composer row. */
export const composerChips = (pending: readonly Pending[]): ComposerAttachment[] =>
  pending.map((p) => {
    const label = p.kind === 'image' ? p.name : p.path;
    return {
      id: p.id,
      label,
      kind: p.kind,
      kindLabel: p.kind === 'image' ? copy.chat.attach.image : copy.chat.attach.file,
      removeLabel: fill(copy.chat.attach.remove, { name: label }),
    };
  });

/** Chips inside a sent user bubble (from the transcript payload). */
export const messageChips = (attachments: readonly CoreAttachment[]): MessageAttachment[] =>
  attachments.map((a) =>
    a.kind === 'image' ? { label: a.name, kind: 'image' } : { label: a.path, kind: 'file' },
  );

/** What `session.sendMessage` carries. */
export const sendAttachments = (
  pending: readonly Pending[],
): CommandInput<'session.sendMessage'>['attachments'] =>
  pending.map((p) =>
    p.kind === 'image'
      ? { kind: 'image' as const, name: p.name, mediaType: p.mediaType as 'image/png', data: p.data }
      : { kind: 'file' as const, path: p.path },
  );

export type ImageError = { message: string };

/** Rejects non-images and oversized images with the §57 copy; otherwise reads the file as base64. */
export const readImage = async (file: File, id: string): Promise<Pending | ImageError> => {
  if (!(IMAGE_MEDIA_TYPES as readonly string[]).includes(file.type))
    return { message: fill(copy.chat.attach.unsupported, { name: file.name }) };
  if (file.size > MAX_IMAGE_BYTES)
    return { message: fill(copy.chat.attach.tooLarge, { name: file.name, max: maxImageLabel }) };
  const data = await base64(file);
  if (data === null) return { message: fill(copy.chat.attach.unsupported, { name: file.name }) };
  return { id, kind: 'image', name: file.name, mediaType: file.type, data, bytes: file.size };
};

export const isImageError = (v: Pending | ImageError): v is ImageError => 'message' in v;

/** `FileReader` result minus the `data:<type>;base64,` prefix; null when the read fails. */
const base64 = (file: File): Promise<string | null> =>
  new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : null);
    };
    reader.readAsDataURL(file);
  });

/** A mention keeps `@path` in the text and adds a file attachment (deduped by path). */
export const withMention = (pending: readonly Pending[], path: string): Pending[] =>
  pending.some((p) => p.kind === 'file' && p.path === path)
    ? [...pending]
    : [...pending, { id: `file:${path}`, kind: 'file', path }];

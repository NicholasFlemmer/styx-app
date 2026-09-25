import {
  IMAGE_MEDIA_TYPES,
  MAX_IMAGE_BYTES,
  MAX_MESSAGE_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  copy,
  fill,
  isSecretFile,
  type CommandInput,
  type Attachment as CoreAttachment,
} from '@styx/core';
import type { ComposerAttachment, MessageAttachment } from '@styx/ui';

/**
 * A pending attachment in the composer: an image read from a paste/drop/pick (sent inline when the agent takes
 * images), any other file read the same way (main saves it into the worktree), or an `@`-mentioned worktree file.
 */
export type Pending =
  | { id: string; kind: 'image'; name: string; mediaType: string; data: string; bytes: number }
  | { id: string; kind: 'upload'; name: string; mediaType: string; data: string; bytes: number }
  | { id: string; kind: 'file'; path: string };

const MB = 1024 * 1024;
const mb = (bytes: number): string => `${Math.round(bytes / MB)} MB`;
export const maxUploadLabel = mb(MAX_UPLOAD_BYTES);
export const maxMessageLabel = mb(MAX_MESSAGE_UPLOAD_BYTES);

const labelOf = (p: Pending): string => (p.kind === 'file' ? p.path : p.name);

/** Chips for the composer row. */
export const composerChips = (pending: readonly Pending[]): ComposerAttachment[] =>
  pending.map((p) => {
    const label = labelOf(p);
    return {
      id: p.id,
      label,
      kind: p.kind === 'image' ? 'image' : 'file',
      kindLabel: p.kind === 'image' ? copy.chat.attach.image : copy.chat.attach.file,
      removeLabel: fill(copy.chat.attach.remove, { name: label }),
    };
  });

/** Chips inside a sent user bubble (from the transcript payload). */
export const messageChips = (attachments: readonly CoreAttachment[]): MessageAttachment[] =>
  attachments.map((a) =>
    a.kind === 'image' ? { label: a.name, kind: 'image' } : { label: a.name ?? a.path, kind: 'file' },
  );

/** What `session.sendMessage` carries. */
export const sendAttachments = (
  pending: readonly Pending[],
): CommandInput<'session.sendMessage'>['attachments'] =>
  pending.map((p) =>
    p.kind === 'image'
      ? { kind: 'image' as const, name: p.name, mediaType: p.mediaType as 'image/png', data: p.data }
      : p.kind === 'upload'
        ? { kind: 'upload' as const, name: p.name, mediaType: p.mediaType, data: p.data }
        : { kind: 'file' as const, path: p.path },
  );

export type AttachError = { message: string };

/** Bytes already pending in the composer (what the 50 MB per-message limit counts). */
export const pendingBytes = (pending: readonly Pending[]): number =>
  pending.reduce((n, p) => n + (p.kind === 'file' ? 0 : p.bytes), 0);

/**
 * Reads any file the person attached: an image the agents take inline (png/jpeg/gif/webp up to 5 MB) becomes an
 * `image`, anything else up to 25 MB an `upload`. Refused, with a line saying why: a folder or unreadable file, an
 * empty file, a key or credentials file, a file over 25 MB, and anything that would take the message past 50 MB.
 */
export const readAttachment = async (
  file: File,
  id: string,
  alreadyPending = 0,
): Promise<Pending | AttachError> => {
  if (isSecretFile(file.name)) return { message: fill(copy.chat.attach.secret, { name: file.name }) };
  if (file.size > MAX_UPLOAD_BYTES)
    return { message: fill(copy.chat.attach.tooLarge, { name: file.name, max: maxUploadLabel }) };
  if (alreadyPending + file.size > MAX_MESSAGE_UPLOAD_BYTES)
    return { message: fill(copy.chat.attach.total, { max: maxMessageLabel }) };
  const data = await base64(file);
  if (data === null) return { message: fill(copy.chat.attach.unsupported, { name: file.name }) };
  if (file.size === 0 || data === '') return { message: fill(copy.chat.attach.empty, { name: file.name }) };
  const inlineImage =
    (IMAGE_MEDIA_TYPES as readonly string[]).includes(file.type) && file.size <= MAX_IMAGE_BYTES;
  return {
    id,
    kind: inlineImage ? 'image' : 'upload',
    name: file.name,
    mediaType: file.type,
    data,
    bytes: file.size,
  };
};

export const isAttachError = (v: Pending | AttachError): v is AttachError => 'message' in v;

/** `FileReader` result minus the `data:<type>;base64,` prefix; null when the read fails (a folder, a moved file). */
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

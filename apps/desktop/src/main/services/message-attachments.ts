import { randomBytes } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import {
  ATTACHMENTS_DIR,
  IMAGE_MEDIA_TYPES,
  MAX_FILE_ATTACHMENT_BYTES,
  MAX_IMAGE_BYTES,
  MAX_MESSAGE_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  copy,
  fill,
  isSecretFile,
  type Attachment,
  type CommandInput,
} from '@styx/core';
import { excludeLocally } from '../agents/git-exclude';
import { fail } from '../ipc/bus';
import { confine } from './confine';
import type { ImageBlock } from './stream-runner';

/** One attachment as the composer sends it: image bytes, a worktree file, or any other file's bytes (`upload`). */
export type AttachmentInput = NonNullable<CommandInput<'session.sendMessage'>['attachments']>[number];

/** A text file inlined into the turn: the name the agent sees and its utf8 contents (never logged). */
export interface InlinedFile {
  path: string;
  text: string;
}

/** A file the agent opens itself: its absolute path in the worktree, what it is, and how big. */
export interface ReferencedFile {
  path: string;
  name: string;
  mediaType: string;
  bytes: number;
}

export interface PreparedAttachments {
  /** Metadata for the transcript row (names, types, sizes — never the bytes). */
  meta: Attachment[];
  /** Base64 image blocks for a session whose agent takes images inline. */
  images: ImageBlock[];
  /** Small text files, inlined after the typed text. */
  files: InlinedFile[];
  /** Everything else: saved in the worktree and named by path. */
  refs: ReferencedFile[];
  /** Worktree-relative paths a held (queued) message keeps; its attachments are read again when it goes out. */
  held: string[];
}

export interface PrepareOptions {
  /** Saved uploads go under `ATTACHMENTS_DIR/<sessionId>/`. */
  sessionId: string;
  /** The session's agent takes base64 image blocks (Claude Code, Codex; an ACP agent that says so). */
  imageBlocks: boolean;
  /** The message waits in the queue: uploads are saved and every attachment is kept as a path, nothing read. */
  hold?: boolean;
}

const MEDIA_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

/** A media type from the file's extension; '' when Styx does not know it. */
export const mediaTypeOf = (name: string): string => MEDIA_BY_EXT[extname(name).toLowerCase()] ?? '';

const isInlineImage = (mediaType: string): boolean =>
  (IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType);

export const humanSize = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${Math.round(bytes / (1024 * 1024))} MB`
    : bytes >= 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${bytes} B`;

const tooLarge = (name: string, max: number): never =>
  fail('invalid-input', fill(copy.chat.attach.tooLarge, { name, max: humanSize(max) }));

/**
 * A file name safe to create inside the attachments folder: the last path segment only, no control characters or
 * characters Windows refuses, no leading dot (it would hide the file), at most 120 characters with the extension
 * kept.
 */
export const safeName = (name: string): string => {
  const last = name.split(/[\\/]/).pop() ?? '';

  let clean = last.replace(/[\u0000-\u001f<>:"|?*]/g, '-').trim();
  clean = clean.replace(/^\.+/, '');
  if (clean === '') clean = 'attachment';
  if (clean.length > 120) {
    const ext = extname(clean).slice(0, 16);
    clean = `${clean.slice(0, 120 - ext.length)}${ext}`;
  }
  return clean;
};

/** Text is what decodes as utf8 and carries no NUL byte early on (the same test git uses for "binary"). */
const looksLikeText = (buf: Buffer): boolean => {
  if (buf.subarray(0, 8000).includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
};

const decode = (name: string, data: string): Buffer => {
  const buf = Buffer.from(data, 'base64');
  if (buf.length === 0) fail('invalid-input', fill(copy.chat.attach.empty, { name }));
  return buf;
};

/**
 * Saves an attached file under `<worktree>/ATTACHMENTS_DIR/<sessionId>/<random>/<name>` (the folder is excluded from
 * git locally, so nothing attached is ever committed or shown as a change) and returns its worktree-relative path.
 */
async function save(worktreePath: string, sessionId: string, name: string, buf: Buffer): Promise<string> {
  const dir = join(worktreePath, ATTACHMENTS_DIR, sessionId, randomBytes(6).toString('hex'));
  await mkdir(dir, { recursive: true });
  const file = join(dir, safeName(name));
  await writeFile(file, buf);
  await excludeLocally(worktreePath, `${ATTACHMENTS_DIR}/`).catch(() => undefined);
  return relative(worktreePath, file).split(sep).join('/');
}

/** The name an attachment is shown by: what the person attached for a saved upload, else its worktree path. */
const nameOf = (rel: string): string | null => (rel.startsWith(`${ATTACHMENTS_DIR}/`) ? basename(rel) : null);

/**
 * Validates, saves and reads the attachments of one user message, whatever their type:
 *
 * - an image the agent takes inline (png/jpeg/gif/webp up to MAX_IMAGE_BYTES) goes as a base64 block;
 * - any other attached file (bytes from the composer, up to MAX_UPLOAD_BYTES) is saved into the worktree;
 * - a worktree file (an `@` mention, or a saved attachment of a held message) must resolve inside the worktree
 *   (same confinement as `fs.*`, symlinks included) and be a regular file;
 * - then a small text file (up to MAX_FILE_ATTACHMENT_BYTES, utf8) is inlined, an image becomes a block when the
 *   agent takes one, and everything else is named by absolute path for the agent's own file tools.
 *
 * Key and credentials files are refused wherever they come from. Rejections are typed `invalid-input` /
 * `fs-denied` failures.
 */
export async function prepareAttachments(
  worktreePath: string,
  attachments: readonly AttachmentInput[],
  opts: PrepareOptions,
): Promise<PreparedAttachments> {
  const out: PreparedAttachments = { meta: [], images: [], files: [], refs: [], held: [] };
  const hold = opts.hold === true;
  let uploaded = 0;
  const count = (name: string, bytes: number): void => {
    uploaded += bytes;
    if (uploaded > MAX_MESSAGE_UPLOAD_BYTES)
      fail('invalid-input', fill(copy.chat.attach.total, { max: humanSize(MAX_MESSAGE_UPLOAD_BYTES) }));
    if (bytes > MAX_UPLOAD_BYTES) tooLarge(name, MAX_UPLOAD_BYTES);
  };

  for (const a of attachments) {
    if (a.kind === 'image' || a.kind === 'upload') {
      const buf = decode(a.name, a.data);
      const mediaType = a.mediaType !== '' ? a.mediaType : mediaTypeOf(a.name);
      if (a.kind === 'upload' && isSecretFile(a.name))
        fail('invalid-input', fill(copy.chat.attach.secret, { name: a.name }));
      count(a.name, buf.length);
      // An image the agent takes inline stays in memory: nothing to save.
      if (!hold && opts.imageBlocks && isInlineImage(mediaType) && buf.length <= MAX_IMAGE_BYTES) {
        out.meta.push({ kind: 'image', name: a.name, mediaType, bytes: buf.length });
        out.images.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: a.data } });
        continue;
      }
      // Anything else — a bigger image, a PDF, a video — is saved and handed over by path.
      const rel = await save(worktreePath, opts.sessionId, a.name, buf);
      await classify(worktreePath, rel, buf.length, opts, out);
      continue;
    }
    const full = confine(worktreePath, a.path);
    const rel = relative(worktreePath, full).split(sep).join('/');
    const info = await stat(full).catch(() => null);
    if (info === null || !info.isFile())
      fail('invalid-input', `${rel || a.path} is not a file in the worktree`);
    if (isSecretFile(rel)) fail('invalid-input', fill(copy.chat.attach.secret, { name: rel }));
    await classify(worktreePath, rel, info.size, opts, out);
  }
  return out;
}

/** Decides how one file in the worktree reaches the agent (see `prepareAttachments`) and records its metadata. */
async function classify(
  worktreePath: string,
  rel: string,
  bytes: number,
  opts: PrepareOptions,
  out: PreparedAttachments,
): Promise<void> {
  const name = nameOf(rel);
  const mediaType = mediaTypeOf(rel);
  const isImage = mediaType.startsWith('image/');
  out.meta.push(
    isImage
      ? { kind: 'image', name: name ?? rel, mediaType, bytes, path: rel }
      : {
          kind: 'file',
          path: rel,
          bytes,
          ...(name !== null ? { name } : {}),
          ...(mediaType !== '' ? { mediaType } : {}),
        },
  );
  if (opts.hold === true) {
    out.held.push(rel);
    return;
  }
  const full = join(worktreePath, rel);
  if (opts.imageBlocks && isInlineImage(mediaType) && bytes <= MAX_IMAGE_BYTES) {
    const data = (await readFile(full)).toString('base64');
    out.images.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
    return;
  }
  if (!isImage && bytes <= MAX_FILE_ATTACHMENT_BYTES) {
    const buf = await readFile(full);
    if (looksLikeText(buf)) {
      out.files.push({ path: name ?? rel, text: buf.toString('utf8') });
      return;
    }
  }
  out.refs.push({ path: full, name: name ?? rel, mediaType, bytes });
}

/**
 * The text the CLI gets: what was typed, then one `<file path="…">` section per inlined file, then the saved
 * attachments by absolute path (every agent can open a path; not every agent takes an image or a PDF inline).
 */
export const composeTurn = (body: string, prepared: Pick<PreparedAttachments, 'files' | 'refs'>): string => {
  const inlined = prepared.files.reduce(
    (text, f) => `${text}\n\n<file path="${f.path}">\n${f.text}\n</file>`,
    body,
  );
  if (prepared.refs.length === 0) return inlined;
  const lines = prepared.refs.map(
    (r) => `- ${r.path} (${r.mediaType !== '' ? `${r.mediaType}, ` : ''}${humanSize(r.bytes)})`,
  );
  return `${inlined}\n\n${copy.agentPrompt.attached}\n${lines.join('\n')}`;
};

/** The chip label of an attachment (image or attached-file name, else the worktree path). */
export const attachmentName = (a: Attachment): string => (a.kind === 'image' ? a.name : (a.name ?? a.path));

export const NO_ATTACHMENTS: PreparedAttachments = { meta: [], images: [], files: [], refs: [], held: [] };

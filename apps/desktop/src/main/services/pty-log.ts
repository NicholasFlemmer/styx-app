import {
  closeSync,
  constants,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { logger, redact } from './logger';

export const PTY_LOG_MAX_BYTES = 5 * 1024 * 1024;
/**
 * How much on-disk text is re-scanned together with the next chunk so a secret split across chunks is still caught:
 * longer than any single-line secret shape `redact()` recognises, including a pasted JWT (L-a). PEM blocks longer
 * than this can still slip through when a chunk boundary lands inside them.
 */
export const REDACT_TAIL = 4096;

/** Last `REDACT_TAIL` chars, never starting on the low half of a surrogate pair (its byte length must match the file). */
const tailOf = (text: string): string => {
  let tail = text.slice(-REDACT_TAIL);
  const first = tail.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1);
  return tail;
};

/** `String.prototype.toWellFormed` (ES2024; Node ≥ 20) behind the ES2023 lib target. */
const wellFormed = (text: string): string => {
  const fn = (text as unknown as { toWellFormed?: () => string }).toWellFormed;
  return typeof fn === 'function' ? fn.call(text) : text;
};

/**
 * Open for writing without O_APPEND, and every write goes at an explicit position (the end the log keeps count of).
 * On Windows an append-mode handle has no right to truncate, so the rewrite that redacts a secret split across two
 * chunks failed there and left the first half of the secret on disk; a plain write handle can truncate everywhere.
 */
const openForWrite = (path: string): number => openSync(path, constants.O_WRONLY | constants.O_CREAT);

interface OpenLog {
  fd: number;
  size: number;
  /** The last `REDACT_TAIL` chars written to the current file (post-redaction), so a secret split across chunks is caught. */
  tail: string;
}

/**
 * Raw session output at `<userData>/logs/pty/<sessionId>.log` (plan §5 SessionService). When a log passes 5 MB it is
 * rotated once to `<sessionId>.log.1` (the previous `.1` is dropped). Writes are synchronous appends: pty chunks are
 * small and ordering matters more than throughput.
 */
export class PtyLog {
  private readonly open = new Map<string, OpenLog>();

  constructor(
    readonly dir: string,
    private readonly maxBytes = PTY_LOG_MAX_BYTES,
  ) {}

  path(sessionId: string): string {
    return join(this.dir, `${sessionId}.log`);
  }

  /**
   * Agents echo tokens (`vercel --token …`, pasted keys) into their terminals; the on-disk log never keeps them.
   * Each chunk is written at once; the tail already on disk is re-scanned together with the new chunk, and when a
   * secret straddles the boundary the tail is truncated and rewritten redacted (L5).
   */
  write(sessionId: string, raw: string): void {
    try {
      const f = this.file(sessionId);
      // A surrogate pair split across pty chunks would otherwise re-join in `tail` (4 bytes) while the file holds two
      // U+FFFD (6 bytes) and the byte accounting behind every truncation would drift.
      raw = wellFormed(raw);
      const chunk = redact(raw);
      const joined = redact(f.tail + raw);
      if (joined === f.tail + chunk) {
        this.append(sessionId, f, chunk);
        return;
      }
      // A secret spans the boundary: drop the on-disk tail and write the redacted join instead.
      const tailBytes = Buffer.byteLength(f.tail);
      ftruncateSync(f.fd, Math.max(0, f.size - tailBytes));
      f.size = Math.max(0, f.size - tailBytes);
      f.tail = '';
      this.append(sessionId, f, joined);
    } catch (e) {
      logger.warn('pty log write failed', { sessionId, error: (e as Error).message });
    }
  }

  private file(sessionId: string): OpenLog {
    let f = this.open.get(sessionId);
    if (!f) {
      mkdirSync(this.dir, { recursive: true });
      const p = this.path(sessionId);
      const size = existsSync(p) ? statSync(p).size : 0;
      f = { fd: openForWrite(p), size, tail: '' };
      this.open.set(sessionId, f);
    }
    return f;
  }

  private append(sessionId: string, f: OpenLog, data: string): void {
    if (data === '') return;
    const bytes = Buffer.byteLength(data);
    if (f.size + bytes > this.maxBytes) {
      // The tail moves into the new file (truncated off the rotated one) so a secret straddling the rotation
      // boundary is rewritten in one place; the rotated file ends where the carried tail begins (L-a).
      const tailBytes = Buffer.byteLength(f.tail);
      ftruncateSync(f.fd, Math.max(0, f.size - tailBytes));
      closeSync(f.fd);
      const p = this.path(sessionId);
      renameSync(p, `${p}.1`);
      f.fd = openForWrite(p);
      f.size = 0;
      if (f.tail !== '') {
        writeSync(f.fd, f.tail, 0);
        f.size = tailBytes;
      }
    }
    writeSync(f.fd, data, f.size);
    f.size += bytes;
    f.tail = tailOf(f.tail + data);
  }

  close(sessionId: string): void {
    const f = this.open.get(sessionId);
    if (!f) return;
    this.open.delete(sessionId);
    try {
      closeSync(f.fd);
    } catch {
      /* already closed */
    }
  }

  /** Deletes the log and its rotated sibling (RetentionJob). */
  remove(sessionId: string): void {
    this.close(sessionId);
    for (const p of [this.path(sessionId), `${this.path(sessionId)}.1`]) rmSync(p, { force: true });
  }

  closeAll(): void {
    for (const id of [...this.open.keys()]) this.close(id);
  }
}

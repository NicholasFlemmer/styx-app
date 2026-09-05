import {
  closeSync,
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
/** Longer than any secret shape `redact()` recognises (short of PEM blocks): how much on-disk text is re-scanned with the next chunk. */
const REDACT_TAIL = 128;

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
      f = { fd: openSync(p, 'a'), size, tail: '' };
      this.open.set(sessionId, f);
    }
    return f;
  }

  private append(sessionId: string, f: OpenLog, data: string): void {
    if (data === '') return;
    const bytes = Buffer.byteLength(data);
    if (f.size + bytes > this.maxBytes) {
      closeSync(f.fd);
      const p = this.path(sessionId);
      renameSync(p, `${p}.1`);
      f.fd = openSync(p, 'a');
      f.size = 0;
      f.tail = ''; // the old tail lives in the rotated file; boundary fix-ups never reach across files
    }
    writeSync(f.fd, data);
    f.size += bytes;
    f.tail = (f.tail + data).slice(-REDACT_TAIL);
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

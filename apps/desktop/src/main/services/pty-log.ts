import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from './logger';

export const PTY_LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Raw session output at `<userData>/logs/pty/<sessionId>.log` (plan §5 SessionService). When a log passes 5 MB it is
 * rotated once to `<sessionId>.log.1` (the previous `.1` is dropped). Writes are synchronous appends: pty chunks are
 * small and ordering matters more than throughput.
 */
export class PtyLog {
  private readonly open = new Map<string, { fd: number; size: number }>();

  constructor(
    readonly dir: string,
    private readonly maxBytes = PTY_LOG_MAX_BYTES,
  ) {}

  path(sessionId: string): string {
    return join(this.dir, `${sessionId}.log`);
  }

  write(sessionId: string, data: string): void {
    try {
      let f = this.open.get(sessionId);
      if (!f) {
        mkdirSync(this.dir, { recursive: true });
        const p = this.path(sessionId);
        const size = existsSync(p) ? statSync(p).size : 0;
        f = { fd: openSync(p, 'a'), size };
        this.open.set(sessionId, f);
      }
      const bytes = Buffer.byteLength(data);
      if (f.size + bytes > this.maxBytes) {
        closeSync(f.fd);
        const p = this.path(sessionId);
        renameSync(p, `${p}.1`);
        f = { fd: openSync(p, 'a'), size: 0 };
        this.open.set(sessionId, f);
      }
      writeSync(f.fd, data);
      f.size += bytes;
    } catch (e) {
      logger.warn('pty log write failed', { sessionId, error: (e as Error).message });
    }
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

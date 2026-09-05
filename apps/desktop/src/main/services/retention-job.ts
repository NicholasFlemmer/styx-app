import { shouldArchive } from '@styx/core';
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import type { Publisher } from '../store/publisher';
import { logger } from './logger';

export const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

export interface RetentionJobDeps {
  repos: Repos;
  publisher: Publisher;
  clock: Clock;
  /** Drops the session's pty logs once it is archived. */
  deleteLogs: (sessionId: string) => void;
  intervalMs?: number;
}

/** Archives `done` sessions older than 7 days (core `shouldArchive`) hourly and on startup; deletes their pty logs. */
export class RetentionJob {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: RetentionJobDeps) {}

  start(): void {
    this.run();
    if (this.timer) return;
    this.timer = setInterval(() => this.run(), this.deps.intervalMs ?? RETENTION_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Returns the ids archived in this pass. */
  run(): string[] {
    const { repos, publisher, clock } = this.deps;
    const now = clock.now();
    const archived: string[] = [];
    for (const s of repos.sessions.all()) {
      if (!shouldArchive(s, now)) continue;
      repos.sessions.upsert({ ...s, archivedAt: now });
      archived.push(s.id);
      try {
        this.deps.deleteLogs(s.id);
      } catch (e) {
        logger.warn('retention: log delete failed', { sessionId: s.id, error: (e as Error).message });
      }
    }
    if (archived.length > 0) {
      publisher.upsert('sessions', archived);
      logger.info('retention: archived sessions', { count: archived.length });
    }
    return archived;
  }
}

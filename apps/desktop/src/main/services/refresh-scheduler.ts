import type { Target } from '@styx/core';
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import { logger } from './logger';

export type RefreshReason = 'interval' | 'focus' | 'wake' | 'manual' | 'startup';

export interface RefreshSchedulerDeps {
  repos: Pick<Repos, 'targets'>;
  /** TargetService.checkHealth: runs the adapter probe and updates health / banner. */
  checkHealth: (target: Target, reason: RefreshReason) => Promise<void>;
  /** SessionService.refreshClis: re-detect agent CLIs on focus / wake / manual runs (cheap: cached per binary). */
  refreshClis?: () => Promise<unknown>;
  clock: Clock;
  /** Every 30 min by default. */
  intervalMs?: number;
  /** Focus/wake runs skip targets probed more recently than this (5 min); manual runs never skip. */
  minGapMs?: number;
  /** Timer primitives, injectable for tests. */
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
  clearInterval?: (handle: unknown) => void;
}

/**
 * Keeps connected targets honest without babysitting (plan §5): every 30 min, on app focus and on wake from sleep,
 * every connected target's `health()` runs. Only a real mint failure flips a target to `expired` (TargetService
 * decides); success clears the banner. Runs are serialised: a focus during an interval run joins it.
 */
export class RefreshScheduler {
  private handle: unknown = null;
  private inFlight: Promise<void> | null = null;

  /** Fixture profiles disable probing entirely (fake credentials would only flag every target expired). */
  private enabled = true;

  constructor(private readonly deps: RefreshSchedulerDeps) {}

  start(): void {
    if (this.handle !== null) return;
    const every = this.deps.intervalMs ?? 30 * 60_000;
    const set = this.deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    const h = set(() => void this.runNow('interval'), every);
    h.unref?.();
    this.handle = h;
  }

  stop(): void {
    if (this.handle === null) return;
    (this.deps.clearInterval ?? ((h) => clearInterval(h as NodeJS.Timeout)))(this.handle);
    this.handle = null;
  }

  /** Probes every connected target (or one), skipping recently-checked ones unless `manual`. Never throws. */
  disable(): void {
    this.enabled = false;
    this.stop();
  }

  runNow(reason: RefreshReason, targetId?: string): Promise<void> {
    if (!this.enabled && reason !== 'manual') return Promise.resolve();
    if (this.inFlight && targetId === undefined) return this.inFlight;
    const run = this.run(reason, targetId).finally(() => {
      if (this.inFlight === run) this.inFlight = null;
    });
    if (targetId === undefined) this.inFlight = run;
    return run;
  }

  private async run(reason: RefreshReason, targetId?: string): Promise<void> {
    if (targetId === undefined && reason !== 'interval' && this.deps.refreshClis !== undefined) {
      try {
        await this.deps.refreshClis();
      } catch (e) {
        logger.warn('refresh: cli detection failed', { error: (e as Error).message });
      }
    }
    const now = this.deps.clock.now();
    const gap = this.deps.minGapMs ?? 5 * 60_000;
    const all =
      targetId === undefined
        ? this.deps.repos.targets.all()
        : [this.deps.repos.targets.get(targetId)].filter((t): t is Target => t !== null);
    for (const t of all) {
      if (t.credentialRef === null) continue;
      if (
        reason !== 'manual' &&
        reason !== 'interval' &&
        t.healthCheckedAt !== null &&
        now - t.healthCheckedAt < gap
      )
        continue;
      try {
        await this.deps.checkHealth(t, reason);
      } catch (e) {
        logger.warn('refresh: health check failed', {
          targetId: t.id,
          provider: t.provider,
          error: (e as Error).message,
        });
      }
    }
  }
}

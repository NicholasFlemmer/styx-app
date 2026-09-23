import type { UsageEvent, UsageReportRow } from '@styx/core';
import { USAGE_BATCH_MAX } from '@styx/core';
import { logger } from './logger';

/**
 * Sends usage counts to the Styx API (owner request, discrepancy #114): how many people use Styx and which
 * parts they reach.
 *
 * What it can send is fixed by the type: a `UsageEvent` name and a count. There is no parameter for anything
 * else, so a project, a path, a branch or a prompt cannot be attached by a later careless change — the only way
 * to add one would be to change the shared type, which is the point.
 *
 * What it will not do, in order of importance:
 * - block anything. Recording is a map write; sending happens on a timer and its failures are swallowed.
 * - send while signed out. Counts belong to an account; without one there is nothing to attach them to and
 *   nothing is kept.
 * - send when the person turned it off.
 * - hoard. A batch that cannot be delivered is dropped at the next flush rather than queued forever.
 */

/** How often the buffer goes out. Long enough that a busy minute is one request. */
const FLUSH_MS = 5 * 60_000;

export interface UsageReportDeps {
  fetch: typeof globalThis.fetch;
  apiBase: () => string;
  /** The account's access token, or null when signed out or it cannot be refreshed. */
  token: () => Promise<string | null>;
  /** The app setting; false means nothing leaves the machine. */
  enabled: () => boolean;
  now: () => number;
}

export class UsageReportService {
  /** `name` → the row being accumulated for it since the last flush. */
  private readonly buffer = new Map<UsageEvent, UsageReportRow>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: UsageReportDeps) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.timer.unref?.();
  }

  /**
   * Notes one occurrence. Cheap and synchronous by design: every caller is on a path the person is waiting on,
   * so this must never be something that can fail or wait.
   */
  record(name: UsageEvent): void {
    if (!this.deps.enabled()) return;
    const existing = this.buffer.get(name);
    if (existing === undefined) this.buffer.set(name, { name, at: this.deps.now(), count: 1 });
    else existing.count += 1;
  }

  /** Sends what has accumulated. Never throws; a failure drops the batch rather than retrying into a pile. */
  async flush(): Promise<void> {
    if (this.buffer.size === 0) return;
    if (!this.deps.enabled()) {
      // Turned off since these were recorded: they are not sent, and they are not kept either.
      this.buffer.clear();
      return;
    }
    const token = await this.deps.token().catch(() => null);
    if (token === null) {
      // Signed out, or the API could not be reached to refresh. Nothing to attach counts to.
      this.buffer.clear();
      return;
    }
    const events = [...this.buffer.values()].slice(0, USAGE_BATCH_MAX);
    this.buffer.clear();
    try {
      await this.deps.fetch(`${this.deps.apiBase().replace(/\/+$/, '')}/v1/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ events }),
      });
    } catch (e) {
      // A count is not worth a retry, a log line at error, or a moment of anyone's attention.
      logger.debug('usage: batch dropped', { error: (e as Error).message });
    }
  }

  /** Last chance to send what is buffered; failures are as unimportant here as anywhere else. */
  async shutdown(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}

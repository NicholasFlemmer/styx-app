import type { UsageBatch, UsageEvent, UsageReportRow } from '@styx/core';
import { installIdSchema, USAGE_BATCH_MAX } from '@styx/core';
import { randomBytes } from 'node:crypto';
import { logger } from './logger';

/**
 * Sends usage counts to the Styx API (owner request, discrepancy #114): how many people use Styx and which
 * parts they reach.
 *
 * What it can send is fixed by the type: a `UsageEvent` name and a count, under a random install id, with the
 * app's version and OS. There is no parameter for anything else, so a project, a path, a branch or a prompt
 * cannot be attached by a later careless change — the only way to add one would be to change the shared type,
 * which is the point.
 *
 * Signed out, counts go under the install id alone (discrepancy #122: downloads and use have to be countable
 * before anyone makes an account). Signed in, the access token goes too, so they also belong to the account.
 *
 * What it will not do, in order of importance:
 * - block anything. Recording is a map write; sending happens on a timer and its failures are swallowed.
 * - send when the person turned it off.
 * - hoard. A batch that cannot be delivered is dropped at the next flush rather than queued forever.
 */

/** Where the install id lives in `ui_state`: per machine, never synced, never in project.json. */
export const INSTALL_ID_KEY = 'usage.installId';

/**
 * This install's id, made on first use and kept. 16 random bytes, so it says nothing about the machine or the
 * person, and deleting Styx's data makes a new one.
 */
export const installIdFrom = (kv: {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}): string => {
  const existing = kv.get<string>(INSTALL_ID_KEY);
  if (existing !== undefined && installIdSchema.safeParse(existing).success) return existing;
  const made = `inst_${randomBytes(16).toString('base64url')}`;
  kv.set(INSTALL_ID_KEY, made);
  return made;
};

/** How often the buffer goes out. Long enough that a busy minute is one request. */
const FLUSH_MS = 5 * 60_000;

export interface UsageReportDeps {
  fetch: typeof globalThis.fetch;
  apiBase: () => string;
  /** The account's access token, or null when signed out or it cannot be refreshed. */
  token: () => Promise<string | null>;
  /** This install's random id (`inst_…`), made once and kept in app settings. */
  installId: () => string;
  /** The app's version, e.g. `0.2.6`. */
  version: string;
  /** `process.platform`. */
  os: string;
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
    const events = [...this.buffer.values()].slice(0, USAGE_BATCH_MAX);
    this.buffer.clear();
    try {
      // Signed out, or the API could not be reached to refresh: the counts still go, under the install alone.
      const token = await this.deps.token().catch(() => null);
      const batch: UsageBatch = {
        installId: this.deps.installId(),
        version: this.deps.version,
        os: this.deps.os,
        events,
      };
      await this.deps.fetch(`${this.deps.apiBase().replace(/\/+$/, '')}/v1/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(batch),
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

import { copy, type TaskResult } from '@styx/core';
import type { Repos } from '../db/repos';

/**
 * Keep it updating weekly (ADR-0033): every Monday from 07:00 local time, a report the person asked to keep up to
 * date is asked for again, by a message to its task. The agent reads the newest numbers and sends the report again
 * with `show_result`; a shared link then shows the new version. Runs while Styx is open: a Monday missed while it
 * was closed is caught up the next time it starts.
 */

export interface ReportScheduleDeps {
  repos: Repos;
  now(): number;
  tell(sessionId: string, text: string): Promise<void>;
  publish(id: string, result: TaskResult | null): void;
}

/** The most recent Monday 07:00 (local) at or before `now`. */
export const lastMondayMorning = (now: number): number => {
  const d = new Date(now);
  const back = (d.getDay() + 6) % 7; // days since Monday
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back, 7, 0, 0, 0);
  return m.getTime() > now ? new Date(m.getFullYear(), m.getMonth(), m.getDate() - 7, 7, 0, 0, 0).getTime() : m.getTime();
};

export class ReportSchedule {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: ReportScheduleDeps) {}

  /** Turns weekly updating on or off for a report task. Starting it does not run it now: Monday does. */
  setWeekly(sessionId: string, weekly: boolean): void {
    const r = this.deps.repos.taskResults.get(sessionId);
    if (r?.body.kind !== 'report') throw new Error('That task has no report.');
    this.deps.repos.taskResults.setWeekly(sessionId, weekly);
    // Counts from now: switching it on on a Tuesday waits for next Monday.
    if (weekly) this.deps.repos.taskResults.setLastRun(sessionId, this.deps.now());
    this.deps.publish(sessionId, this.deps.repos.taskResults.get(sessionId));
  }

  /** Asks every weekly report that is due for its new version. */
  async tick(): Promise<string[]> {
    const now = this.deps.now();
    const since = lastMondayMorning(now);
    const asked: string[] = [];
    for (const r of this.deps.repos.taskResults.all()) {
      if (!r.weekly || r.body.kind !== 'report') continue;
      if (r.lastRunAt !== null && r.lastRunAt >= since) continue;
      if (this.deps.repos.sessions.get(r.id)?.archivedAt != null) continue;
      this.deps.repos.taskResults.setLastRun(r.id, now);
      asked.push(r.id);
      await this.deps.tell(r.id, copy.agentPrompt.reportUpdate).catch(() => undefined);
    }
    return asked;
  }

  start(everyMs = 10 * 60_000): void {
    if (this.timer !== null) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

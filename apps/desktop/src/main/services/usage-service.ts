import { agentLimitsSchema, type Agent, type AgentLimits } from '@styx/core';
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import type { Publisher } from '../store/publisher';
import { readCodexRateLimits } from './app-server-client';
import { logger } from './logger';

/** `usage.limits.<agent>` in app_settings: the latest report per agent, so the Usage page has it after a restart. */
export const LIMITS_KEY_PREFIX = 'usage.limits.';
export const limitsKey = (agent: Agent): string => `${LIMITS_KEY_PREFIX}${agent}`;

export interface UsageServiceDeps {
  repos: Repos;
  publisher: Publisher;
  clock: Clock;
  /**
   * Reads Codex's limits on demand (`account/rateLimits/read` over a short-lived app-server); faked in tests. Null
   * when the binary has no app-server or reported nothing.
   */
  readCodex?: (bin: string) => Promise<AgentLimits | null>;
  env?: NodeJS.ProcessEnv;
}

/**
 * Usage page (owner request after t3code): keeps the latest rate limits each CLI reported. Reports arrive with
 * sessions (Claude `rate_limit_event`, Codex `account/rateLimits/updated`) through the session service's
 * `limitsReported` hook; Refresh asks Codex directly. Claude Code has no on-demand call, so its row only moves
 * while one of its sessions runs (the page says so).
 */
export class UsageService {
  private readonly limits = new Map<Agent, AgentLimits>();
  private readonly readCodex: (bin: string) => Promise<AgentLimits | null>;
  private refreshing: Promise<void> | null = null;

  constructor(private readonly deps: UsageServiceDeps) {
    this.readCodex =
      deps.readCodex ??
      ((bin) => readCodexRateLimits(bin, () => deps.clock.now(), { env: deps.env ?? process.env }));
    for (const [key, value] of Object.entries(deps.repos.settings.kv.all())) {
      if (!key.startsWith(LIMITS_KEY_PREFIX)) continue;
      const parsed = agentLimitsSchema.safeParse(value);
      if (parsed.success) this.limits.set(parsed.data.agent, parsed.data);
      else deps.repos.settings.kv.delete(key); // an unreadable row is dropped rather than shown as fact
    }
  }

  /** Every agent's latest report, for the snapshot. */
  all(): Record<string, AgentLimits> {
    const out: Record<string, AgentLimits> = {};
    for (const [agent, limits] of this.limits) out[agent] = limits;
    return out;
  }

  /** A CLI reported its limits: stamped with the main clock, persisted, and pushed to every window. */
  report(limits: AgentLimits): AgentLimits {
    const stamped: AgentLimits = { ...limits, updatedAt: this.deps.clock.now() };
    this.limits.set(stamped.agent, stamped);
    this.deps.repos.settings.kv.set(limitsKey(stamped.agent), stamped);
    this.deps.publisher.limitsSet(stamped);
    return stamped;
  }

  /**
   * Usage › Refresh: asks Codex through its app-server when one is installed with that capability. Concurrent
   * refreshes share one call; a failure is logged (the page keeps the last report) and never thrown to the renderer.
   */
  refreshLimits(): Promise<void> {
    if (this.refreshing !== null) return this.refreshing;
    this.refreshing = this.refreshCodex().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refreshCodex(): Promise<void> {
    const cli = this.deps.repos.discovery.cli('codex');
    if (cli === null || !cli.found || cli.binary === null || cli.capabilities['appServer'] !== true) return;
    try {
      const limits = await this.readCodex(cli.binary);
      if (limits !== null) this.report(limits);
    } catch (e) {
      logger.warn('usage: codex rate limits refresh failed', { error: (e as Error).message });
    }
  }
}

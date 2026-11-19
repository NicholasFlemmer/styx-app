import {
  copy,
  fill,
  launchCap,
  taskResultBodySchema,
  type ConnectedApp,
  type ConnectedAppTool,
  type TaskResult,
} from '@styx/core';
import type { Repos } from '../db/repos';
import type { AuditInput } from './audit-service';
import { redact } from './logger';

/**
 * Campaign and report results (ADR-0033). The agent hands one over with `show_result`; Styx keeps it (strings
 * redacted, shape checked) and draws it. A campaign's launch plan, once the person approves it, lets the agent take
 * exactly the steps the plan covers in Meta Ads without asking again: a paused campaign capped at the plan's total,
 * ad sets whose daily budgets add up to no more than the plan's daily amount, ads in them, and starting only what it
 * made under the plan. Everything else still asks. The objects made under a plan are remembered in memory: after a
 * restart they ask again (fails closed).
 */

export interface TaskResultsDeps {
  repos: Repos;
  now(): number;
  publish(id: string, result: TaskResult | null): void;
  audit(input: AuditInput): void;
  /** Tells the agent, as Styx, what the person decided. */
  tell(sessionId: string, text: string): Promise<void>;
}

/** What one approved plan has made, and reserved, so far. */
interface PlanState {
  /** The one Meta Ads app the plan runs in, from its first step. */
  appId: string | null;
  /** Campaigns made or being made under the plan: at most one. */
  campaigns: number;
  ids: Set<string>;
  /** Daily budgets of the plan's ad sets (major units, to the cent), by id or by a pending reservation. */
  budgets: Map<string, number>;
  /** The ads the person picked: the only ones the plan lets the agent make. */
  ads: { headline: string; body: string }[];
  /** Nothing made under the plan may run past this. */
  endBy: number;
}

/** What a step under a plan has reserved until it has run. */
export type Reservation =
  | { kind: 'campaign' }
  | { kind: 'adset'; key: string }
  | { kind: 'budget'; id: string; prev: number }
  | { kind: 'none' };

const DAY = 86_400_000;

const deepRedact = (v: unknown): unknown =>
  typeof v === 'string'
    ? redact(v)
    : Array.isArray(v)
      ? v.map(deepRedact)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepRedact(x)]))
        : v;

/** Thrown for a result the agent should fix; its message says what. */
export class ResultRefusal extends Error {}

export class TaskResultsService {
  private readonly plans = new Map<string, PlanState>();
  private seq = 0;

  constructor(private readonly deps: TaskResultsDeps) {}

  all(): TaskResult[] {
    return this.deps.repos.taskResults.all();
  }

  /** Keeps the agent's result for its task; a new one replaces the old (and any approval of the old plan). */
  show(sessionId: string, projectId: string, raw: unknown): TaskResult {
    const parsed = taskResultBodySchema.safeParse(deepRedact(raw));
    if (!parsed.success)
      throw new ResultRefusal(
        `That result does not fit: ${parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.') || 'result'}: ${i.message}`)
          .join('; ')}`,
      );
    this.deps.repos.taskResults.put({
      id: sessionId,
      projectId,
      body: parsed.data,
      updatedAt: this.deps.now(),
    });
    this.plans.delete(sessionId);
    const kept = this.deps.repos.taskResults.get(sessionId);
    if (kept === null) throw new ResultRefusal('That result could not be kept.');
    this.deps.publish(sessionId, kept);
    return kept;
  }

  /**
   * The person approves the launch plan they were looking at (`seenAt`), with the ads they picked; the agent is
   * told to go ahead, within it. A plan swapped since, or approved already, is refused.
   */
  async approveLaunch(sessionId: string, picked: number[], seenAt: number): Promise<void> {
    const result = this.deps.repos.taskResults.get(sessionId);
    if (result === null || result.body.kind !== 'campaign' || result.body.launch === undefined)
      throw new Error(copy.one.results.noPlan);
    const ads = result.body.ads;
    const picks = [...new Set(picked)].filter((i) => i >= 0 && i < ads.length).sort((a, b) => a - b);
    if (picks.length === 0) throw new Error(copy.one.results.noPicks);
    const plan = result.body.launch;
    const now = this.deps.now();
    if (!this.deps.repos.taskResults.approveLaunch(sessionId, now, seenAt, picks))
      throw new Error(copy.one.results.planChanged);
    this.plans.set(sessionId, {
      appId: null,
      campaigns: 0,
      ids: new Set(),
      budgets: new Map(),
      ads: picks.flatMap((i) => (ads[i] === undefined ? [] : [ads[i]])),
      endBy: now + (plan.days + 1) * DAY,
    });
    this.deps.publish(sessionId, this.deps.repos.taskResults.get(sessionId));
    const session = this.deps.repos.sessions.get(sessionId);
    this.deps.audit({
      actorKind: 'you',
      actorLabel: 'you',
      action: 'granted',
      projectId: result.projectId,
      sessionId,
      worktreeId: session?.worktreeId ?? null,
      targetLabel: `Meta Ads · ${result.body.title}`,
      triggeredBy: 'launch plan',
      detail: {
        perDay: plan.perDay,
        days: plan.days,
        cap: launchCap(plan),
        currency: plan.currency,
        countries: plan.countries ?? null,
        ads: picks.length,
      },
    });
    await this.deps.tell(
      sessionId,
      fill(copy.agentPrompt.launchApproved, {
        perDay: plan.perDay,
        days: plan.days,
        cap: launchCap(plan),
        currency: plan.currency,
        audience: plan.audience,
        countries: (plan.countries ?? []).join(', ') || 'as planned',
        endBy: new Date(now + plan.days * DAY).toISOString(),
        ads: picks
          .flatMap((i) => (ads[i] === undefined ? [] : [ads[i]]))
          .map((a) => `- ${a.product}: headline "${a.headline}", message "${a.body}"`)
          .join('\n'),
      }),
    );
  }

  /** The approved plan for a session while it is still running, or null. */
  private livePlan(sessionId: string) {
    const result = this.deps.repos.taskResults.get(sessionId);
    const state = this.plans.get(sessionId);
    if (
      result === null ||
      state === undefined ||
      result.body.kind !== 'campaign' ||
      result.body.launch === undefined ||
      result.launchApprovedAt === null
    )
      return null;
    if (this.deps.now() > state.endBy) return null;
    return { plan: result.body.launch, state };
  }

  /**
   * Whether an approved launch plan covers this Meta Ads step, so it need not ask again. When it does, what the
   * step would use is reserved at once (one campaign, its share of the daily amount), so calls made together cannot
   * each pass the same check; `planSettle` keeps or releases it once the step has run. Returns the reservation, or
   * null to ask the person as usual.
   */
  planReserve(
    sessionId: string,
    app: ConnectedApp,
    tool: ConnectedAppTool,
    args: Record<string, unknown>,
  ): Reservation | null {
    if (app.kind !== 'meta-ads') return null;
    const live = this.livePlan(sessionId);
    if (live === null) return null;
    const { plan, state } = live;
    // One account, in the plan's currency.
    if (app.currency !== plan.currency) return null;
    if (state.appId !== null && state.appId !== app.id) return null;
    const cents = (k: string) => Math.round(Number(args[k]) * 100) / 100;
    const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '');
    const daily = () => [...state.budgets.values()].reduce((a, b) => a + b, 0);
    let reservation: Reservation | null = null;
    switch (tool.name) {
      case 'create_campaign': {
        const cap = cents('spend_cap');
        if (state.campaigns > 0 || !(cap > 0) || cap > launchCap(plan)) return null;
        state.campaigns = 1;
        reservation = { kind: 'campaign' };
        break;
      }
      case 'create_ad_set': {
        const amount = cents('daily_budget');
        const end = Date.parse(str('end_time'));
        const countries = Array.isArray(args['countries']) ? args['countries'] : [];
        if (!state.ids.has(str('campaign_id')) || !(amount > 0) || daily() + amount > plan.perDay)
          return null;
        if (Number.isNaN(end) || end > state.endBy) return null;
        if (
          plan.countries !== undefined &&
          (countries.length === 0 ||
            !countries.every((c) => typeof c === 'string' && plan.countries?.includes(c)))
        )
          return null;
        const key = `pending:${++this.seq}`;
        state.budgets.set(key, amount);
        reservation = { kind: 'adset', key };
        break;
      }
      case 'create_ad': {
        if (!state.ids.has(str('adset_id'))) return null;
        // Only the ads the person picked, word for word.
        if (!state.ads.some((a) => a.headline === str('headline') && a.body === str('message'))) return null;
        reservation = { kind: 'none' };
        break;
      }
      case 'activate':
      case 'pause':
        if (!state.ids.has(str('id'))) return null;
        reservation = { kind: 'none' };
        break;
      case 'set_daily_budget': {
        const id = str('id');
        const amount = cents('amount');
        const prev = state.budgets.get(id);
        if (prev === undefined || !(amount > 0) || daily() - prev + amount > plan.perDay) return null;
        state.budgets.set(id, amount);
        reservation = { kind: 'budget', id, prev };
        break;
      }
      default:
        return null;
    }
    state.appId = app.id;
    return reservation;
  }

  /** After a step that ran under a plan: keep what it made, or release what it reserved when it failed. */
  planSettle(sessionId: string, r: Reservation, ok: boolean, text: string): void {
    const state = this.plans.get(sessionId);
    if (state === undefined) return;
    let id: string | null = null;
    if (ok)
      try {
        const v = (JSON.parse(text) as { id?: unknown }).id;
        if (typeof v === 'string' && /^\d{5,25}$/.test(v)) id = v;
      } catch {
        id = null;
      }
    switch (r.kind) {
      case 'campaign':
        if (id === null) state.campaigns = ok ? state.campaigns : 0;
        else state.ids.add(id);
        return;
      case 'adset': {
        const amount = state.budgets.get(r.key) ?? 0;
        state.budgets.delete(r.key);
        // A made ad set keeps its share; one Meta refused gives it back.
        if (id !== null) {
          state.ids.add(id);
          state.budgets.set(id, amount);
        } else if (ok) state.budgets.set(r.key, amount);
        return;
      }
      case 'budget':
        if (!ok) state.budgets.set(r.id, r.prev);
        return;
      case 'none':
        if (id !== null) state.ids.add(id);
        return;
    }
  }
}

import {
  campaignAdSchema,
  type CampaignLive,
  copy,
  fill,
  formatMoney,
  launchCap,
  launchPlanSchema,
  taskResultBodySchema,
  type ConnectedApp,
  type ConnectedAppTool,
  type TaskResult,
} from '@styx/core';
import type { Repos } from '../db/repos';
import type { AuditInput } from './audit-service';
import { appMayReach } from './connected-apps-service';
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
  /** Fetches an ad's picture (main only: the window never loads addresses an agent chose). */
  fetch?: typeof fetch;
  /** OS authentication (Touch ID, Windows Hello, polkit) before money is committed. */
  verify(reason: string): Promise<'ok' | 'failed' | 'unavailable' | 'cancelled'>;
  /** The Meta Ads app the plan runs in, connected, for Pause everything and the live numbers. */
  meta(
    projectId: string,
  ): { pause(id: string): Promise<void>; live(campaignId: string): Promise<CampaignLive> } | null;
}

/** What the person approves: the picked ads as they edited them, and the plan with their numbers. */
export interface LaunchApproval {
  seenAt: number;
  ads: { index: number; headline: string; body: string }[];
  perDay: number;
  days: number;
  countries: string[] | null;
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
const IMAGE_MAX = 4 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

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
  private readonly images = new Map<string, string>();

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
   * The person approves exactly what they see: the result they were looking at (`seenAt`), the ads they picked as
   * they edited them, and the plan with their numbers. Money is committed, so it asks for OS authentication first.
   * A plan swapped since, or approved already, is refused. The agent is then told to launch exactly that.
   */
  async approveLaunch(sessionId: string, a: LaunchApproval): Promise<void> {
    const result = this.deps.repos.taskResults.get(sessionId);
    if (result === null || result.body.kind !== 'campaign' || result.body.launch === undefined)
      throw new Error(copy.one.results.noPlan);
    if (result.updatedAt !== a.seenAt || result.launchApprovedAt !== null)
      throw new Error(copy.one.results.planChanged);
    const body = result.body;
    const picks = [...new Map(a.ads.map((x) => [x.index, x])).values()]
      .filter((x) => body.ads[x.index] !== undefined)
      .sort((x, y) => x.index - y.index);
    if (picks.length === 0) throw new Error(copy.one.results.noPicks);
    const ads = picks.flatMap((x) => {
      const ad = body.ads[x.index];
      return ad === undefined
        ? []
        : [{ ...ad, headline: redact(x.headline).trim(), body: redact(x.body).trim() }];
    });
    const plan = launchPlanSchema.parse({
      ...body.launch,
      perDay: a.perDay,
      days: a.days,
      ...(a.countries !== null && a.countries.length > 0 ? { countries: a.countries } : {}),
    });
    const approved = { ads: campaignAdSchema.array().parse(ads), plan };
    const auth = await this.deps.verify(
      `Launch ${body.title}: ${formatMoney(plan.perDay, plan.currency)} a day, ${formatMoney(launchCap(plan), plan.currency)} at most`,
    );
    if (auth === 'unavailable') throw new Error(copy.one.results.authUnavailable);
    if (auth !== 'ok') throw new Error(copy.one.results.authCancelled);
    const now = this.deps.now();
    if (
      !this.deps.repos.taskResults.approveLaunch(
        sessionId,
        now,
        a.seenAt,
        picks.map((x) => x.index),
        approved,
      )
    )
      throw new Error(copy.one.results.planChanged);
    this.plans.set(sessionId, {
      appId: null,
      campaigns: 0,
      ids: new Set(),
      budgets: new Map(),
      ads: approved.ads,
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
      targetLabel: `Meta Ads · ${body.title}`,
      triggeredBy: 'launch plan',
      detail: {
        perDay: plan.perDay,
        days: plan.days,
        cap: launchCap(plan),
        currency: plan.currency,
        countries: plan.countries ?? null,
        ads: approved.ads.length,
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
        ads: approved.ads
          .map(
            (x) =>
              `- ${x.product}: headline "${x.headline}", message "${x.body}"${x.image ? `, image ${x.image}` : ''}${x.link ? `, link ${x.link}` : ''}`,
          )
          .join('\n'),
      }),
    );
  }

  /** Pause everything: the person stops every ad the plan made, at once, without asking the agent. */
  async pauseAll(sessionId: string): Promise<void> {
    const result = this.deps.repos.taskResults.get(sessionId);
    if (result === null || result.campaignId === null) throw new Error(copy.one.results.nothingLive);
    const meta = this.deps.meta(result.projectId);
    if (meta === null) throw new Error(copy.one.results.metaGone);
    await meta.pause(result.campaignId);
    const now = this.deps.now();
    this.deps.repos.taskResults.setPaused(sessionId, now);
    // Nothing more may run under the plan once the person has stopped it.
    this.plans.delete(sessionId);
    this.deps.publish(sessionId, this.deps.repos.taskResults.get(sessionId));
    const session = this.deps.repos.sessions.get(sessionId);
    this.deps.audit({
      actorKind: 'you',
      actorLabel: 'you',
      action: 'revoked',
      projectId: result.projectId,
      sessionId,
      worktreeId: session?.worktreeId ?? null,
      targetLabel: `Meta Ads · ${result.body.title}`,
      triggeredBy: 'pause everything',
      detail: { campaign: result.campaignId },
    });
  }

  /**
   * An ad's picture as a data URL, fetched here so the window keeps its strict image policy: https only, never a
   * private address, no redirects, images only, 4 MB at most. Null when it cannot be shown.
   */
  async adImage(sessionId: string, index: number): Promise<string | null> {
    const result = this.deps.repos.taskResults.get(sessionId);
    const ad =
      result?.body.kind === 'campaign'
        ? ((result.approved?.ads ?? result.body.ads)[index] ?? result.body.ads[index])
        : undefined;
    if (ad?.image === undefined) return null;
    const cached = this.images.get(ad.image);
    if (cached !== undefined) return cached;
    let url: URL;
    try {
      url = new URL(ad.image);
    } catch {
      return null;
    }
    if (!appMayReach(new URL('https://example.com'), url)) return null;
    try {
      const res = await (this.deps.fetch ?? fetch)(url.toString(), { redirect: 'error' });
      const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
      if (!res.ok || !IMAGE_TYPES.has(type)) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > IMAGE_MAX) return null;
      const data = `data:${type};base64,${bytes.toString('base64')}`;
      if (this.images.size > 100) this.images.clear();
      this.images.set(ad.image, data);
      return data;
    } catch {
      return null;
    }
  }

  /** The campaign's numbers from Meta, for the live view. */
  async live(sessionId: string): Promise<CampaignLive | null> {
    const result = this.deps.repos.taskResults.get(sessionId);
    if (result === null || result.campaignId === null) return null;
    const meta = this.deps.meta(result.projectId);
    if (meta === null) return null;
    return meta.live(result.campaignId);
  }

  /** The approved plan for a session while it is still running, or null. */
  private livePlan(sessionId: string) {
    const result = this.deps.repos.taskResults.get(sessionId);
    const state = this.plans.get(sessionId);
    if (
      result === null ||
      state === undefined ||
      result.body.kind !== 'campaign' ||
      result.approved === null ||
      result.launchApprovedAt === null ||
      result.pausedAt !== null
    )
      return null;
    if (this.deps.now() > state.endBy) return null;
    return { plan: result.approved.plan, state };
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
        else {
          state.ids.add(id);
          // Kept: the live view and Pause everything follow this campaign, across restarts.
          this.deps.repos.taskResults.setCampaign(sessionId, id);
          this.deps.publish(sessionId, this.deps.repos.taskResults.get(sessionId));
        }
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

/** The `one` fixture's Meta: a live campaign's numbers, and a pause that answers at once. Never the network. */
export const demoMeta = (now: () => number) => ({
  pause: async (_id: string): Promise<void> => undefined,
  live: async (_id: string): Promise<CampaignLive> => ({
    status: 'active',
    spent: 8940,
    sales: 71400,
    clicks: 2800,
    ads: [
      { id: '1', name: 'Still thinking about it? · Hoodie', spent: 5210, clicks: 1840, sales: 48900 },
      { id: '2', name: 'Your tote is waiting · Tote', spent: 3730, clicks: 960, sales: 22500 },
    ],
    readAt: now(),
  }),
});

import type { ConnectedAppTool } from '@styx/core';
import type { AppConnection } from './connected-apps-service';

/**
 * Meta Ads, built in (ADR-0033 tier 1): the Marketing API behind the same gate as every connected app. Reads run at
 * once; anything that starts, stops or changes spend asks the person first, with the amount in the question. A new
 * campaign is always made paused. Every id an agent names is checked to belong to the connected ad account, so a
 * token that reaches other accounts never acts on them. The token stays in main; agents see only results.
 */

export const META_GRAPH = 'https://graph.facebook.com/v23.0';

export const META_TOOLS: ConnectedAppTool[] = [
  {
    name: 'list_campaigns',
    title: 'List campaigns',
    description:
      'Campaigns in the ad account with status, objective and budget (budgets in the account currency).',
    readOnly: true,
  },
  {
    name: 'list_ads',
    title: 'List ads',
    description: 'Ads in the ad account with status and their campaign and ad set ids.',
    readOnly: true,
  },
  {
    name: 'insights',
    title: 'Read results',
    description:
      'Spend, impressions, clicks, CTR, CPC and actions for the account or one campaign / ad set / ad. Args: id (optional), period: today | yesterday | last_7d | last_30d | this_month (default last_7d).',
    readOnly: true,
  },
  {
    name: 'create_campaign',
    title: 'Create a paused campaign',
    description:
      'Creates a campaign, always paused (nothing spends until activate). Args: name, objective (OUTCOME_TRAFFIC, OUTCOME_LEADS, OUTCOME_SALES, OUTCOME_AWARENESS, OUTCOME_ENGAGEMENT), spend_cap (optional, the most it may ever spend, in the account currency; required under an approved launch plan). Returns its id.',
    readOnly: false,
  },
  {
    name: 'create_ad_set',
    title: 'Create a paused ad set: sets a daily budget',
    description:
      'Creates a paused ad set in a campaign. Args: campaign_id, name, daily_budget (account currency), countries (two-letter codes, e.g. ["ZA"]), age_min (default 18), age_max (default 65), optimization_goal (LINK_CLICKS, LANDING_PAGE_VIEWS, REACH or IMPRESSIONS; default LINK_CLICKS), end_time (optional ISO date). Returns its id.',
    readOnly: false,
  },
  {
    name: 'create_ad',
    title: 'Create a paused ad',
    description:
      'Creates a paused link ad in an ad set. Args: adset_id, name, page_id (the Facebook Page it runs as), link (https), headline, message, image_url (https). Returns its id.',
    readOnly: false,
  },
  {
    name: 'activate',
    title: 'Start it: starts spending',
    description: 'Sets a campaign, ad set or ad to ACTIVE, so it starts spending. Args: id.',
    readOnly: false,
  },
  {
    name: 'pause',
    title: 'Pause it',
    description: 'Sets a campaign, ad set or ad to PAUSED. Args: id.',
    readOnly: false,
  },
  {
    name: 'set_daily_budget',
    title: 'Change the daily budget: changes spend',
    description:
      'Sets the daily budget of a campaign or ad set. Args: id, amount (in the account currency, e.g. 150.00).',
    readOnly: false,
  },
];

/** Currencies Meta counts in whole units (no cents); every other one in hundredths. */
const WHOLE_UNIT = new Set(['CLP', 'COP', 'CRC', 'HUF', 'ISK', 'IDR', 'JPY', 'KRW', 'PYG', 'TWD', 'VND']);

/** The amount as Meta counts it (its minor unit), for a currency Styx knows; null otherwise (fail closed). */
export const metaMinorUnits = (amount: number, currency: string): number | null =>
  /^[A-Z]{3}$/.test(currency) ? Math.round(amount * (WHOLE_UNIT.has(currency) ? 1 : 100)) : null;

const GOALS = new Set(['LINK_CLICKS', 'LANDING_PAGE_VIEWS', 'REACH', 'IMPRESSIONS']);

const text = (v: unknown, name: string, max: number): string => {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`${name} is required.`);
  return v.trim().slice(0, max);
};

const httpsArg = (v: unknown, name: string): string => {
  try {
    const u = new URL(String(v));
    if (u.protocol === 'https:') return u.toString();
  } catch {
    // refused below
  }
  throw new Error(`${name} must be an https address.`);
};

const PERIODS = new Set(['today', 'yesterday', 'last_7d', 'last_30d', 'this_month']);
const OBJECTIVES = new Set([
  'OUTCOME_AWARENESS',
  'OUTCOME_TRAFFIC',
  'OUTCOME_ENGAGEMENT',
  'OUTCOME_LEADS',
  'OUTCOME_APP_PROMOTION',
  'OUTCOME_SALES',
]);

/** An ad account id as Meta writes it, `act_<digits>`; refuses anything else. */
export const metaAccountId = (raw: string): string | null => {
  const digits = raw.trim().replace(/^act_/, '');
  return /^\d{5,25}$/.test(digits) ? `act_${digits}` : null;
};

const idArg = (args: Record<string, unknown>): string => {
  const id = args['id'];
  if (typeof id !== 'string' || !/^\d{5,25}$/.test(id))
    throw new Error('id must be a numeric Meta object id.');
  return id;
};

export class MetaAdsConnection implements AppConnection {
  private currency: string | null = null;

  constructor(
    private readonly token: string,
    private readonly account: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async graph(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const url = new URL(`${META_GRAPH}/${path}`);
    const body = new URLSearchParams({ ...params, access_token: this.token });
    const res =
      method === 'GET'
        ? await this.fetchFn(`${url.toString()}?${body.toString()}`)
        : await this.fetchFn(url.toString(), { method: 'POST', body });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = json['error'] as { message?: unknown } | undefined;
      // Meta's message, never the request (it carries the token).
      throw new Error(`Meta: ${typeof err?.message === 'string' ? err.message.slice(0, 300) : res.status}`);
    }
    return json;
  }

  /** An amount in the account currency as Meta counts it; refused when the currency is not one Styx knows. */
  private async minor(raw: unknown): Promise<number> {
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000)
      throw new Error('Amounts must be positive numbers in the account currency.');
    if (this.currency === null) await this.check();
    const minor = metaMinorUnits(amount, this.currency ?? '');
    if (minor === null) throw new Error('Styx does not know how Meta counts this account’s currency.');
    return minor;
  }

  /** Refuses an id outside the connected ad account. */
  private async own(id: string): Promise<void> {
    const r = await this.graph('GET', id, { fields: 'account_id' });
    if (`act_${String(r['account_id'] ?? '')}` !== this.account)
      throw new Error('That id is not in the connected ad account.');
  }

  /** Who the token is and which account it reaches: the sign-in check. */
  async check(): Promise<{ name: string; currency: string }> {
    const r = await this.graph('GET', this.account, { fields: 'name,currency' });
    this.currency = typeof r['currency'] === 'string' ? r['currency'] : null;
    return { name: String(r['name'] ?? this.account), currency: this.currency ?? '' };
  }

  async listTools(): Promise<ConnectedAppTool[]> {
    await this.check();
    return META_TOOLS;
  }

  /** A refusal or Meta's own error comes back as the tool's error, for the agent to correct, not as an outage. */
  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    try {
      return await this.run(name, args);
    } catch (e) {
      return { text: e instanceof Error ? e.message : String(e), isError: true };
    }
  }

  private async run(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }> {
    const out = (v: unknown) => ({ text: JSON.stringify(v), isError: false });
    switch (name) {
      case 'list_campaigns':
        return out(
          await this.graph('GET', `${this.account}/campaigns`, {
            fields:
              'id,name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time',
            limit: '50',
          }),
        );
      case 'list_ads':
        return out(
          await this.graph('GET', `${this.account}/ads`, {
            fields: 'id,name,status,effective_status,campaign_id,adset_id',
            limit: '50',
          }),
        );
      case 'insights': {
        const period =
          typeof args['period'] === 'string' && PERIODS.has(args['period']) ? args['period'] : 'last_7d';
        const target = args['id'] === undefined ? this.account : idArg(args);
        if (target !== this.account) await this.own(target);
        return out(
          await this.graph('GET', `${target}/insights`, {
            fields: 'spend,impressions,clicks,ctr,cpc,actions',
            date_preset: period,
          }),
        );
      }
      case 'create_campaign': {
        const nameArg = args['name'];
        const objective = args['objective'];
        if (typeof nameArg !== 'string' || nameArg.trim() === '') throw new Error('name is required.');
        if (typeof objective !== 'string' || !OBJECTIVES.has(objective))
          throw new Error(`objective must be one of ${[...OBJECTIVES].join(', ')}.`);
        return out(
          await this.graph('POST', `${this.account}/campaigns`, {
            name: nameArg.slice(0, 200),
            objective,
            status: 'PAUSED',
            special_ad_categories: '[]',
            ...(args['spend_cap'] === undefined
              ? {}
              : { spend_cap: String(await this.minor(args['spend_cap'])) }),
          }),
        );
      }
      case 'create_ad_set': {
        const campaign = idArg({ id: args['campaign_id'] });
        await this.own(campaign);
        const name = text(args['name'], 'name', 200);
        const daily = await this.minor(args['daily_budget']);
        const countries = Array.isArray(args['countries'])
          ? args['countries'].filter((c): c is string => typeof c === 'string' && /^[A-Z]{2}$/.test(c))
          : [];
        if (countries.length === 0)
          throw new Error('countries must list two-letter country codes, like ["ZA"].');
        const ageMin = Math.max(13, Math.min(65, Number(args['age_min'] ?? 18) || 18));
        const ageMax = Math.max(ageMin, Math.min(65, Number(args['age_max'] ?? 65) || 65));
        const goal =
          typeof args['optimization_goal'] === 'string' && GOALS.has(args['optimization_goal'])
            ? args['optimization_goal']
            : 'LINK_CLICKS';
        const end =
          typeof args['end_time'] === 'string' && !Number.isNaN(Date.parse(args['end_time']))
            ? { end_time: new Date(args['end_time']).toISOString() }
            : {};
        return out(
          await this.graph('POST', `${this.account}/adsets`, {
            name,
            campaign_id: campaign,
            daily_budget: String(daily),
            billing_event: 'IMPRESSIONS',
            optimization_goal: goal,
            bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
            targeting: JSON.stringify({
              geo_locations: { countries: countries.slice(0, 25) },
              age_min: ageMin,
              age_max: ageMax,
            }),
            status: 'PAUSED',
            ...end,
          }),
        );
      }
      case 'create_ad': {
        const adset = idArg({ id: args['adset_id'] });
        await this.own(adset);
        const page = idArg({ id: args['page_id'] });
        const link = httpsArg(args['link'], 'link');
        const picture = httpsArg(args['image_url'], 'image_url');
        const creative = await this.graph('POST', `${this.account}/adcreatives`, {
          name: text(args['name'], 'name', 200),
          object_story_spec: JSON.stringify({
            page_id: page,
            link_data: {
              link,
              message: text(args['message'], 'message', 1000),
              name: text(args['headline'], 'headline', 200),
              picture,
            },
          }),
        });
        const creativeId = String(creative['id'] ?? '');
        if (!/^\d{5,25}$/.test(creativeId)) throw new Error('Meta did not make the ad creative.');
        return out(
          await this.graph('POST', `${this.account}/ads`, {
            name: text(args['name'], 'name', 200),
            adset_id: adset,
            creative: JSON.stringify({ creative_id: creativeId }),
            status: 'PAUSED',
          }),
        );
      }
      case 'activate':
      case 'pause': {
        const id = idArg(args);
        await this.own(id);
        return out(await this.graph('POST', id, { status: name === 'activate' ? 'ACTIVE' : 'PAUSED' }));
      }
      case 'set_daily_budget': {
        const id = idArg(args);
        const amount = Number(args['amount']);
        if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000)
          throw new Error('amount must be a positive number in the account currency.');
        await this.own(id);
        return out(await this.graph('POST', id, { daily_budget: String(await this.minor(amount)) }));
      }
      default:
        throw new Error(`Meta Ads has no tool "${name}".`);
    }
  }

  async close(): Promise<void> {
    return undefined;
  }
}

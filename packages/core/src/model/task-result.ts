import { z } from 'zod';

/**
 * A task's result, as the agent hands it to Styx (`show_result`, ADR-0033): a campaign (ad drafts, then a launch
 * plan the person approves) or a report (findings in plain words first, the numbers and their sources under them).
 * Styx draws it; the agent never draws its own UI. Everything here came from an agent: strings are redacted before
 * they are kept, sizes are capped, and nothing in it can approve or spend anything by itself.
 */

const line = (max: number) => z.string().trim().min(1).max(max);
const opt = (max: number) => z.string().trim().max(max).optional();
/** An https address an agent supplies (a product photo, a landing page); anything else is dropped. */
const httpsUrl = z
  .string()
  .trim()
  .max(1000)
  .refine((v) => {
    try {
      return new URL(v).protocol === 'https:';
    } catch {
      return false;
    }
  })
  .optional()
  .catch(undefined);

export const campaignAdSchema = z.object({
  /** What it sells: "Hoodie". */
  product: line(80),
  headline: line(120),
  body: line(400),
  /** "about R71 a sale": the agent's honest estimate, said as such. */
  estimate: opt(120),
  /** The agent's own pick for launch; the person can change the picks. */
  picked: z.boolean().default(false),
  /** The picture (https, e.g. the product photo from the store) and where the ad leads. */
  image: httpsUrl,
  link: httpsUrl,
  /** The button: "Shop now", "Learn more". */
  cta: opt(30),
});
export type CampaignAd = z.infer<typeof campaignAdSchema>;

export const launchPlanSchema = z.object({
  platform: z.enum(['meta']),
  /** Major units of the ad account's currency. */
  perDay: z.number().positive().max(10_000_000),
  days: z.number().int().min(1).max(90),
  currency: z.string().regex(/^[A-Z]{3}$/),
  audience: line(300),
  /** Where the ads may run (two-letter codes); ad sets made under the plan must stay inside them. */
  countries: z
    .array(z.string().regex(/^[A-Z]{2}$/))
    .min(1)
    .max(25)
    .optional(),
  /** "Friday 00:00" etc: as the agent said it, for showing. */
  starts: opt(80),
  stops: opt(80),
});
export type LaunchPlan = z.infer<typeof launchPlanSchema>;

export const campaignResultSchema = z.object({
  kind: z.literal('campaign'),
  title: line(160),
  /** What it is for, said plainly: "Sales", "Leads". */
  goal: opt(60),
  /** Who the ads run as: the Page name. */
  page: opt(80),
  /** What it looked at, one line each: "Read 30 days of sales in Shopify: …". */
  lookedAt: z.array(line(300)).max(12).default([]),
  summary: opt(600),
  ads: z.array(campaignAdSchema).min(1).max(12),
  launch: launchPlanSchema.optional(),
});
export type CampaignResult = z.infer<typeof campaignResultSchema>;

export const reportMetricSchema = z.object({
  label: line(60),
  value: line(40),
  /** "▲ 18%", "budget R33 000". */
  change: opt(60),
  /** Whether the change is good news; drawn as such only when given. */
  good: z.boolean().optional(),
});

export const reportResultSchema = z.object({
  kind: z.literal('report'),
  title: line(160),
  /** "10 to 16 November". */
  period: opt(80),
  /** When the numbers were read: "Mon 17 Nov, 07:00". */
  asOf: opt(80),
  /** Where the numbers came from: "Google Ads", "Analytics". */
  sources: z.array(line(60)).max(12).default([]),
  /** The answer, in one sentence. */
  headline: line(200),
  summary: opt(1200),
  metrics: z.array(reportMetricSchema).max(8).default([]),
  /** One bar chart: a label and a number each. */
  bars: z
    .object({
      title: line(80),
      items: z.array(z.object({ label: line(60), value: z.number().min(0) })).max(12),
    })
    .optional(),
  table: z
    .object({
      columns: z.array(line(40)).min(1).max(8),
      rows: z.array(z.array(z.string().max(80)).max(8)).max(40),
    })
    .optional(),
  /** A line over time, this period against the last: same number of points each. */
  trend: z
    .object({
      title: line(80),
      labels: z.array(z.string().max(20)).min(2).max(60),
      current: z.array(z.number()).min(2).max(60),
      previous: z.array(z.number()).max(60).optional(),
    })
    .optional()
    .catch(undefined),
  recommendations: z
    .array(z.object({ title: line(160), why: opt(300) }))
    .max(8)
    .default([]),
});
export type ReportResult = z.infer<typeof reportResultSchema>;

export const taskResultBodySchema = z.discriminatedUnion('kind', [campaignResultSchema, reportResultSchema]);
export type TaskResultBody = z.infer<typeof taskResultBodySchema>;

export const taskResultSchema = z.object({
  /** The session (task) it belongs to: one result per task, replaced when the agent sends a new one. */
  id: z.string().min(1),
  projectId: z.string().min(1),
  body: taskResultBodySchema,
  /** The person approved the launch plan exactly as it is (cleared when a new result replaces it). */
  launchApprovedAt: z.number().int().nonnegative().nullable().default(null),
  /** The ads the person picked when approving (by position); the only ads the plan lets the agent make. */
  launchPicked: z.array(z.number().int().min(0)).max(12).default([]),
  /** Exactly what the person approved: their edits to the picked ads and to the plan. */
  approved: z
    .object({ ads: z.array(campaignAdSchema).min(1).max(12), plan: launchPlanSchema })
    .nullable()
    .default(null),
  /** The campaign the approved plan made, once it exists (Meta id). */
  campaignId: z
    .string()
    .regex(/^\d{5,25}$/)
    .nullable()
    .default(null),
  /** The person pressed Pause everything. */
  pausedAt: z.number().int().nonnegative().nullable().default(null),
  updatedAt: z.number().int().nonnegative(),
});
export type TaskResult = z.infer<typeof taskResultSchema>;

/** A campaign's numbers, read from Meta for the live view. Money in the account currency (major units). */
export const campaignLiveSchema = z.object({
  status: z.enum(['active', 'paused', 'ended', 'pending']),
  spent: z.number().nonnegative(),
  /** What it sold, when the account reports purchase value; null when it does not. */
  sales: z.number().nonnegative().nullable(),
  clicks: z.number().int().nonnegative(),
  ads: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        spent: z.number().nonnegative(),
        clicks: z.number().int().nonnegative(),
        sales: z.number().nonnegative().nullable(),
      }),
    )
    .max(50),
  readAt: z.number().int().nonnegative(),
});
export type CampaignLive = z.infer<typeof campaignLiveSchema>;

/** The most a launch plan can spend, in major units. */
export const launchCap = (p: LaunchPlan): number => Math.round(p.perDay * p.days * 100) / 100;

/** Money the way the person reads it: "R 5 000" for rand, "$5,000" for dollars; whole units. */
export const formatMoney = (amount: number, currency: string): string => {
  try {
    return new Intl.NumberFormat(currency === 'ZAR' ? 'en-ZA' : 'en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    }).format(amount);
  } catch {
    return `${currency} ${Math.round(amount)}`;
  }
};

import { copy, fill } from '../copy';
import type { Agent } from '../model/common';
import type { Session } from '../model/session';
import type { AgentLimits } from '../model/usage';
import type { ReadModel } from '../read-model';
import { rows } from '../read-model';
import { formatCost, formatTokens } from './chat';
import { projectNameOf } from './common';
import { formatAge, formatCountdown } from './format';

/**
 * Usage page (owner request after t3code): what every agent and project cost across the sessions Styx ran, summed
 * from each session's running totals (`costUsd` / `numTurns` from Claude's `result`, `tokensUsed` from Codex's
 * `tokenUsage/updated`), plus the latest rate limits each CLI reported. Estimates, never a bill.
 */

export interface UsageRow {
  /** Agent id or project id; `total` for the totals row. */
  key: string;
  label: string;
  sessions: number;
  turns: number;
  tokens: number;
  costUsd: number;
}

export interface UsageTable {
  /** Sorted by cost, then tokens, then sessions (all descending), then label. */
  rows: UsageRow[];
  total: UsageRow;
}

/** Product order for the Limits block (the Settings › Agents order), shell excluded. */
const AGENT_ORDER = (Object.keys(copy.agentProducts) as Agent[]).filter((a) => a !== 'shell');

/**
 * Every session Styx ran, archived ones included (the usage was spent either way). Shell sessions consume no
 * model usage and are left out so the tables only count agents.
 */
const agentSessions = (model: ReadModel): Session[] =>
  rows(model.sessions).filter((s) => s.agent !== 'shell');

const emptyRow = (key: string, label: string): UsageRow => ({
  key,
  label,
  sessions: 0,
  turns: 0,
  tokens: 0,
  costUsd: 0,
});

const add = (row: UsageRow, s: Session): void => {
  row.sessions += 1;
  row.turns += s.numTurns;
  row.tokens += s.tokensUsed ?? 0;
  row.costUsd += s.costUsd;
};

const byUsage = (a: UsageRow, b: UsageRow): number =>
  b.costUsd - a.costUsd || b.tokens - a.tokens || b.sessions - a.sessions || a.label.localeCompare(b.label);

const tableOf = (
  sessions: Session[],
  keyOf: (s: Session) => string,
  labelOf: (key: string) => string,
): UsageTable => {
  const byKey = new Map<string, UsageRow>();
  const total = emptyRow('total', copy.usage.total);
  for (const s of sessions) {
    const key = keyOf(s);
    let row = byKey.get(key);
    if (row === undefined) {
      row = emptyRow(key, labelOf(key));
      byKey.set(key, row);
    }
    add(row, s);
    add(total, s);
  }
  return { rows: [...byKey.values()].sort(byUsage), total };
};

/** Usage › By agent: one row per agent that ran at least one session, labelled by product. */
export const usageByAgent = (model: ReadModel): UsageTable =>
  tableOf(
    agentSessions(model),
    (s) => s.agent,
    (key) => copy.agentProducts[key as Agent],
  );

/** Usage › By project: one row per project with at least one agent session (removed projects keep their name). */
export const usageByProject = (model: ReadModel): UsageTable =>
  tableOf(
    agentSessions(model),
    (s) => s.projectId,
    (key) => projectNameOf(model, key as Session['projectId']),
  );

/** Table cells for one usage row: counts plain, tokens `14.6k`, cost `$0.12`; a zero token / cost total is "—", not a claim. */
export const usageCells = (
  row: UsageRow,
): { sessions: string; turns: string; tokens: string; cost: string } => ({
  sessions: String(row.sessions),
  turns: String(row.turns),
  tokens: row.tokens > 0 ? formatTokens(row.tokens) : copy.general.none,
  cost: row.costUsd > 0 ? formatCost(row.costUsd) : copy.general.none,
});

export interface LimitWindowRow {
  label: string;
  /** 0–100, rounded; drives the bar. */
  usedPercent: number;
  /** "5 h · 42% used" */
  used: string;
  /** "resets in 2h 10m", or null when the CLI gave no reset time. */
  resets: string | null;
}

export interface LimitRow {
  agent: Agent;
  /** Product name ("Claude Code"). */
  label: string;
  /** "plan team", or null when the CLI names no plan. */
  plan: string | null;
  windows: LimitWindowRow[];
  /** Age of the report: "now" · "2m" · "1h". */
  reported: string;
}

const clampPercent = (n: number): number => Math.min(100, Math.max(0, Math.round(n)));

const windowRow = (w: AgentLimits['windows'][number], now: number): LimitWindowRow => ({
  label: w.label,
  usedPercent: clampPercent(w.usedPercent),
  used: fill(copy.usage.window, { label: w.label, used: clampPercent(w.usedPercent) }),
  resets:
    w.resetsAt === null
      ? null
      : fill(copy.usage.resets, {
          when: fill(copy.usage.resetsIn, { t: formatCountdown(Math.max(0, w.resetsAt - now)) }),
        }),
});

/** Usage › Limits: the latest report per agent, in product order; agents that never reported are absent. */
export const limitRows = (model: ReadModel, now: number): LimitRow[] =>
  AGENT_ORDER.flatMap((agent) => {
    const limits = model.limits[agent];
    if (limits === undefined) return [];
    return [
      {
        agent,
        label: copy.agentProducts[agent],
        plan:
          limits.plan === null || limits.plan === '' ? null : fill(copy.usage.plan, { plan: limits.plan }),
        windows: limits.windows.map((w) => windowRow(w, now)),
        reported: formatAge(limits.updatedAt, now),
      },
    ];
  });

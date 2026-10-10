import { copy, fill, rows } from '@styx/core';
import type { GrantId, PendingAsk, Policy, ReadModel } from '@styx/core';

/** Policies in evaluation order (`ord`), the order the pane lists them (spec §4.5). */
export const policiesInOrder = (model: ReadModel): Policy[] =>
  rows(model.policies).sort((a, b) => a.ord - b.ord);

/** "matches 12 today" for auto-approve / ask rules; "revoked 5 this week" for idle-expiry. */
export const policyMeta = (policy: Policy): string =>
  policy.rule.kind === 'idle-expiry'
    ? fill(copy.policies.revokedThisWeek, { n: policy.matchCountWeek })
    : fill(copy.policies.matchesToday, { n: policy.matchCountToday });

/** Inbox footer count: today's matches of every auto-approve rule (prototype reads 12 with rule #1 off). */
export const autoApprovedToday = (policies: readonly Policy[]): number =>
  policies.filter((p) => p.rule.kind === 'auto-approve').reduce((n, p) => n + p.matchCountToday, 0);

/** "auto-approved today: 12, by policy #1": names the auto-approve rules that actually matched today, if any. */
export const inboxFooter = (policies: readonly Policy[]): string => {
  const n = autoApprovedToday(policies);
  const matched = [...policies]
    .filter((p) => p.rule.kind === 'auto-approve' && p.matchCountToday > 0)
    .sort((a, b) => a.ord - b.ord)
    .map((p) => fill(copy.approvals.footerRule, { ord: p.ord }));
  return matched.length === 0
    ? fill(copy.approvals.footer, { n })
    : fill(copy.approvals.footerByRules, { n, rules: matched.join(', ') });
};

/** The open grant ask behind an inbox row, so Review can open the session with its sheet. */
export const askForGrant = (model: ReadModel, grantId: GrantId): PendingAsk | null =>
  rows(model.pendingAsks).find((a) => a.kind === 'grant' && a.grantId === grantId && a.state === 'open') ??
  null;

/**
 * Audit clocks are rendered in local time; with a frozen clock (`STYX_NOW`, visual harness) they read UTC so
 * fixture labels ("09:41") are stable across machines.
 */
export const clockOffsetMinutes = (frozen: boolean, at: number): number =>
  frozen ? 0 : -new Date(at).getTimezoneOffset();

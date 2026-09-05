import { copy, fill } from '../copy';
import type { AuditEntry } from '../model/audit';
import { AGENT_LABEL } from '../model/common';
import type { BuiltinPolicyKey, Policy } from '../model/policy';
import type { ReadModel } from '../read-model';
import { rows } from '../read-model';
import { formatClock, joinScopes } from './format';

export interface AuditRow {
  id: AuditEntry['id'];
  /** "09:41" */
  t: string;
  /** "you" | "system" | "Claude" */
  who: string;
  /** "vercel-prod" */
  target: string;
  /** "used deploy token (auto: policy #1)" */
  what: string;
  time: number;
}

const agentName = (entry: AuditEntry): string =>
  entry.agent === null ? entry.actorLabel : AGENT_LABEL[entry.agent];

const policyOrd = (policies: readonly Policy[], entry: AuditEntry): number | null =>
  policies.find((p) => p.id === entry.policyId)?.ord ?? null;

/** Drawer "Policy" row (prototype `adRows`): builtins get the short prototype label, custom rules their text. */
const BUILTIN_POLICY_SHORT_LABEL: Record<BuiltinPolicyKey, string> = {
  'auto-read-staging-preview': 'auto-approve staging reads',
  'ask-mfa-prod-write': 'ask + MFA',
  'idle-expiry-1h': 'idle expiry',
};

export const policyShortLabel = (policy: Pick<Policy, 'ord' | 'ruleText' | 'builtinKey'>): string =>
  `#${policy.ord} ${policy.builtinKey === null ? policy.ruleText : BUILTIN_POLICY_SHORT_LABEL[policy.builtinKey]}`;

const detailNumber = (entry: AuditEntry, key: string): string => {
  const v = entry.detail[key];
  return typeof v === 'number' || typeof v === 'string' ? String(v) : '?';
};

/** The one-line "what" column, built from structured fields (never stored as prose). */
export const auditWhat = (entry: AuditEntry, policies: readonly Policy[]): string => {
  const scopes = joinScopes(entry.scope ?? []);
  const agent = agentName(entry);
  const reason = entry.detail['reason'];
  const reasonLabel =
    typeof reason === 'string' && reason in copy.audit.reasons
      ? copy.audit.reasons[reason as keyof typeof copy.audit.reasons]
      : (entry.triggeredBy ?? copy.audit.none);
  switch (entry.action) {
    case 'used': {
      const ord = policyOrd(policies, entry);
      return ord === null
        ? fill(copy.audit.actions.used, { scope: scopes })
        : fill(copy.audit.actions.usedAuto, { scope: scopes, n: ord });
    }
    case 'granted': {
      const base = fill(copy.audit.actions.granted, { scopes, agent, duration: entry.duration ?? copy.audit.none });
      const ord = policyOrd(policies, entry);
      // Spec §1: policy auto-approvals are logged "auto: policy #n".
      return entry.detail['decidedBy'] === 'policy' && ord !== null ? `${base} (${fill(copy.policies.autoLabel, { n: ord })})` : base;
    }
    case 'denied':
      return fill(copy.audit.actions.denied, { scopes, agent });
    case 'requested':
      return fill(copy.audit.actions.requested, { scopes });
    case 'revoked':
      return fill(copy.audit.actions.revoked, { agent, reason: reasonLabel });
    case 'expired':
      return fill(copy.audit.actions.expired, { agent, reason: reasonLabel });
    case 'opened-pr':
      return fill(copy.audit.actions.openedPr, { n: detailNumber(entry, 'prNumber') });
    case 'merged-pr':
      return fill(copy.audit.actions.mergedPr, { n: detailNumber(entry, 'prNumber') });
    case 'connected':
      return copy.audit.actions.connected;
    case 'disconnected':
      return copy.audit.actions.disconnected;
    case 'tested':
      return copy.audit.actions.tested;
    case 'policy-changed':
      return copy.audit.actions.policyChanged;
    case 'exported':
      return copy.audit.actions.exported;
  }
};

export const auditRow = (
  entry: AuditEntry,
  policies: readonly Policy[],
  now: number,
  utcOffsetMinutes = 0,
): AuditRow => ({
  id: entry.id,
  t: now - entry.time < 60_000 ? 'now' : formatClock(entry.time, utcOffsetMinutes),
  who: entry.actorKind === 'agent' ? agentName(entry) : entry.actorLabel,
  target: entry.targetLabel ?? copy.audit.none,
  what: auditWhat(entry, policies),
  time: entry.time,
});

/** Newest first. */
export const auditRows = (model: ReadModel, now: number, utcOffsetMinutes = 0): AuditRow[] => {
  const policies = rows(model.policies);
  return rows(model.auditEntries)
    .sort((a, b) => b.seq - a.seq)
    .map((e) => auditRow(e, policies, now, utcOffsetMinutes));
};

export interface AuditDetailRow {
  k: string;
  v: string;
}

/** Drawer rows: Actor, Target, Scope, Duration, Session, Worktree, Triggered by, Policy (spec §4.8). */
export const auditDetailRows = (
  entry: AuditEntry,
  policies: readonly Policy[],
  utcOffsetMinutes = 0,
): AuditDetailRow[] => {
  const none = copy.audit.none;
  const policy = policies.find((p) => p.id === entry.policyId);
  const grantedAt = entry.action === 'granted' && entry.duration === '1h' ? entry.time + 60 * 60_000 : null;
  const duration =
    grantedAt !== null
      ? fill(copy.audit.durationDetail.expires, {
          duration: '1h',
          t: formatClock(grantedAt, utcOffsetMinutes),
        })
      : entry.action === 'used' && entry.policyId !== null
        ? copy.audit.durationDetail.policySingleUse
        : (entry.duration ?? none);
  return [
    { k: copy.audit.rows.actor, v: entry.actorKind === 'agent' ? agentName(entry) : entry.actorLabel },
    { k: copy.audit.rows.target, v: entry.targetLabel ?? none },
    { k: copy.audit.rows.scope, v: entry.scope === null ? none : joinScopes(entry.scope, ', ') },
    { k: copy.audit.rows.duration, v: duration },
    { k: copy.audit.rows.session, v: entry.sessionLabel ?? none },
    { k: copy.audit.rows.worktree, v: entry.worktreeLabel ?? none },
    { k: copy.audit.rows.triggeredBy, v: entry.triggeredBy ?? none },
    { k: copy.audit.rows.policy, v: policy === undefined ? none : policyShortLabel(policy) },
  ];
};

/** "Revoke now" is disabled when already revoked or system-issued (spec §4.8). */
export const canRevokeFromAudit = (entry: AuditEntry, model: ReadModel): boolean => {
  if (entry.grantId === null) return false;
  const grant = model.grants.byId[entry.grantId];
  return grant !== undefined && grant.state === 'active' && grant.decidedBy === 'user';
};

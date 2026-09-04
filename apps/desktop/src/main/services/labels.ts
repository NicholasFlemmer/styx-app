import { AGENT_LABEL, type AuditDraft, type Session, type Target, type Worktree } from '@styx/core';
import type { Repos } from '../db/repos';
import { targetLabel } from '../db/repos/targets';
import type { AuditInput } from './audit-service';

/** "codex · acme-shop" (audit session label). */
export const sessionLabel = (session: Pick<Session, 'agent'>, projectName: string): string =>
  `${session.agent} · ${projectName}`;

export const actorForSession = (
  session: Pick<Session, 'agent'> | null,
): { kind: AuditDraft['actorKind']; label: string } =>
  session === null
    ? { kind: 'system', label: 'system' }
    : { kind: 'agent', label: AGENT_LABEL[session.agent] };

/** Denormalised labels for an audit row (the audit outlives the rows it points at). */
export const auditContext = (
  repos: Repos,
  parts: {
    session?: Session | null;
    target?: Target | null;
    worktree?: Worktree | null;
    projectId?: string | null;
  },
): Pick<
  AuditInput,
  | 'projectId'
  | 'targetId'
  | 'sessionId'
  | 'worktreeId'
  | 'targetLabel'
  | 'sessionLabel'
  | 'worktreeLabel'
  | 'agent'
> => {
  const session = parts.session ?? null;
  const target = parts.target ?? null;
  const worktree = parts.worktree ?? (session ? repos.worktrees.get(session.worktreeId) : null);
  const projectId = parts.projectId ?? session?.projectId ?? target?.projectId ?? null;
  const project = projectId ? repos.projects.get(projectId) : null;
  return {
    projectId,
    targetId: target?.id ?? null,
    sessionId: session?.id ?? null,
    worktreeId: worktree?.id ?? null,
    targetLabel: target ? targetLabel(target) : null,
    sessionLabel: session ? sessionLabel(session, project?.name ?? 'project') : null,
    worktreeLabel: worktree?.branch ?? null,
    agent: session?.agent ?? null,
  };
};

/** Core `AuditDraft` (machine effect) → `AuditService.append` input. */
export const draftToInput = (d: AuditDraft): AuditInput => ({
  time: d.time,
  actorKind: d.actorKind,
  /** The machine labels agent actors with the session label; audit rows carry the product name ("Claude"). */
  actorLabel: d.actorKind === 'agent' && d.agent !== null ? AGENT_LABEL[d.agent] : d.actorLabel,
  action: d.action,
  projectId: d.projectId,
  targetId: d.targetId,
  sessionId: d.sessionId,
  worktreeId: d.worktreeId,
  grantId: d.grantId,
  policyId: d.policyId,
  targetLabel: d.targetLabel,
  sessionLabel: d.sessionLabel,
  worktreeLabel: d.worktreeLabel,
  agent: d.agent,
  scope: d.scope === null ? null : [...d.scope],
  duration: d.duration,
  triggeredBy: d.triggeredBy ?? '',
  detail: d.detail,
});

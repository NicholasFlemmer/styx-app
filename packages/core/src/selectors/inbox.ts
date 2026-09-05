import type { GrantId, ProjectId, SessionId, TargetId } from '../ids';
import { copy, fill } from '../copy';
import { PROVIDER_LABEL } from '../model/common';
import type { Env, Scope } from '../model/common';
import type { Target } from '../model/target';
import type { ReadModel } from '../read-model';
import { rows } from '../read-model';
import { agentLabel, branchOf, projectNameOf } from './common';
import { formatAge, joinScopes } from './format';

/** Most-privileged first: the inbox tag shows the one scope that decides the policy (`read+write` → `WRITE`). */
const SCOPE_PRIORITY: readonly Scope[] = ['delete', 'deploy', 'write', 'read'];

/** "Supabase prod" / "AWS acme-prod" / "Vercel": prod targets named after their bare provider get the env appended. */
export const inboxTargetLabel = (target: Pick<Target, 'name' | 'provider' | 'env'>): string =>
  target.env === 'prod' && target.name === PROVIDER_LABEL[target.provider]
    ? `${target.name} ${target.env}`
    : target.name;

export const headlineScope = (scopes: readonly Scope[]): string =>
  SCOPE_PRIORITY.find((s) => scopes.includes(s)) ?? joinScopes(scopes, ', ');

export interface InboxRow {
  grantId: GrantId;
  sessionId: SessionId | null;
  projectId: ProjectId;
  targetId: TargetId;
  agent: string;
  project: string;
  /** "Supabase prod" / "AWS acme-prod" / "Vercel" — see `inboxTargetLabel`. */
  target: string;
  env: Env;
  prod: boolean;
  /** The headline scope tag (`write` for a read+write request); `scopes` carries the full request. */
  scope: string;
  scopes: Scope[];
  reason: string;
  age: string;
  requestedAt: number;
}

/** Approvals → Inbox: every requested grant, newest first. */
export const inboxRows = (model: ReadModel, now: number): InboxRow[] =>
  rows(model.grants)
    .filter((g) => g.state === 'requested')
    .sort((a, b) => b.requestedAt - a.requestedAt)
    .flatMap((g) => {
      const target = model.targets.byId[g.targetId];
      if (target === undefined) return [];
      const session = g.sessionId === null ? undefined : model.sessions.byId[g.sessionId];
      return [
        {
          grantId: g.id,
          sessionId: g.sessionId,
          projectId: target.projectId,
          targetId: target.id,
          agent: session === undefined ? copy.general.none : agentLabel(session),
          project: projectNameOf(model, target.projectId),
          target: inboxTargetLabel(target),
          env: target.env,
          prod: target.env === 'prod',
          scope: headlineScope(g.scope),
          scopes: [...g.scope],
          reason: g.reason,
          age: formatAge(g.requestedAt, now),
          requestedAt: g.requestedAt,
        },
      ];
    });

export const inboxTabLabel = (model: ReadModel, now: number): string =>
  fill(copy.approvals.tabs.inboxCount, { n: inboxRows(model, now).length });

export interface ToastModel {
  header: string;
  source: string;
  title: string;
  meta: string;
  review: string;
  later: string;
}

/** "Codex wants Supabase prod · write" / `acme-shop · test/flaky · "migration 0042"` (spec §10 Toast). */
export const toastFor = (model: ReadModel, grantId: GrantId): ToastModel | null => {
  const grant = model.grants.byId[grantId];
  if (grant === undefined || grant.sessionId === null) return null;
  const session = model.sessions.byId[grant.sessionId];
  const target = model.targets.byId[grant.targetId];
  if (session === undefined || target === undefined) return null;
  const scope = grant.scope.includes('write') ? 'write' : joinScopes(grant.scope, ', ');
  return {
    header: copy.toast.header,
    source: copy.toast.source,
    title: fill(copy.toast.title, {
      agent: agentLabel(session),
      target: `${target.name} ${target.env}`,
      scope,
    }),
    meta: fill(copy.toast.meta, {
      project: projectNameOf(model, session.projectId),
      branch: branchOf(model, session),
      reason: grant.reason,
    }),
    review: copy.toast.review,
    later: copy.toast.later,
  };
};

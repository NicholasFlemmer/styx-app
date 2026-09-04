import type { GrantId, ProjectId, TargetId } from '../ids';
import { isLive, openUntil } from '../machines/grant';
import { copy, fill } from '../copy';
import type { Grant } from '../model/grant';
import type { Target } from '../model/target';
import type { ReadModel } from '../read-model';
import { rows } from '../read-model';
import { formatCountdown } from './format';

export type TargetStateKind = 'unconnected' | 'locked' | 'open' | 'persistent' | 'expired';

/** `label`: "locked" · "persistent" · "expired" · "unconnected" · "open · 58m left". */
export type TargetDerivedState =
  | { kind: 'open'; label: string; openUntil: number; grantId: GrantId }
  | { kind: 'persistent'; label: string; grantId?: GrantId }
  | { kind: Exclude<TargetStateKind, 'open' | 'persistent'>; label: string };

export const liveGrantsOnTarget = (model: ReadModel, targetId: TargetId, now: number): Grant[] =>
  rows(model.grants).filter((g) => g.targetId === targetId && isLive(g, now));

/**
 * unconnected (no credentialRef) → expired (health) → persistent (live `always` grant, or a target whose
 * policy is `always` and therefore never asks) → open (any live grant; open until the earliest expiry) → locked.
 */
export const targetDerivedState = (model: ReadModel, targetId: TargetId, now: number): TargetDerivedState => {
  const target = model.targets.byId[targetId];
  if (target === undefined || target.credentialRef === null) {
    return { kind: 'unconnected', label: copy.targets.state.unconnected };
  }
  if (target.health === 'expired') return { kind: 'expired', label: copy.targets.state.expired };
  const live = liveGrantsOnTarget(model, targetId, now);
  const persistent = live.find((g) => g.duration === 'always');
  if (persistent !== undefined) {
    return { kind: 'persistent', label: copy.targets.state.persistent, grantId: persistent.id };
  }
  if (target.policy === 'always') return { kind: 'persistent', label: copy.targets.state.persistent };
  let best: Grant | null = null;
  let until: number | null = null;
  for (const g of live) {
    const u = openUntil(g);
    if (u !== null && (until === null || u < until)) {
      until = u;
      best = g;
    }
  }
  if (best !== null && until !== null) {
    return {
      kind: 'open',
      label: fill(copy.targets.state.open, { t: formatCountdown(until - now) }),
      openUntil: until,
      grantId: best.id,
    };
  }
  return { kind: 'locked', label: copy.targets.state.locked };
};

export interface TargetRow {
  targetId: TargetId;
  name: string;
  env: Target['env'];
  prod: boolean;
  policy: Target['policy'];
  policyLabel: string;
  state: TargetDerivedState;
  /** Revoke when open/persistent-by-grant, Connect when unconnected, else Edit. */
  action: 'Revoke' | 'Edit' | 'Connect';
}

/** Revoke is offered when a grant backs the state (open, or persistent via an `always` grant). */
export const revokable = (state: TargetDerivedState): boolean =>
  state.kind === 'open' || (state.kind === 'persistent' && state.grantId !== undefined);

/** Settings → Targets table rows for a project. */
export const targetRows = (model: ReadModel, projectId: ProjectId, now: number): TargetRow[] =>
  rows(model.targets)
    .filter((t) => t.projectId === projectId)
    .map((t) => {
      const state = targetDerivedState(model, t.id, now);
      const action: TargetRow['action'] =
        state.kind === 'unconnected'
          ? copy.targets.actions.connect
          : revokable(state)
            ? copy.targets.actions.revoke
            : copy.targets.actions.edit;
      return {
        targetId: t.id,
        name: t.name,
        env: t.env,
        prod: t.env === 'prod',
        policy: t.policy,
        policyLabel: copy.targets.policy[t.policy],
        state,
        action,
      };
    });

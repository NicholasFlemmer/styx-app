import {
  isDeployableTarget,
  copy,
  fill,
  isDeployActive,
  rows,
  type ProjectId,
  type ReadModel,
  type Target,
  type TargetId,
} from '@styx/core';

/** How a target is named wherever the deploy button, toast and status bar mention it: `Vercel prod`. */
export const deployTargetLabel = (t: Pick<Target, 'name' | 'env'>): string => `${t.name} ${t.env}`;

export interface DeployOption {
  targetId: TargetId;
  label: string;
  name: string;
  env: string;
  prod: boolean;
}

export type DeployButtonState =
  /** No deployable target: the button is disabled with `copy.deploy.noTarget` as its title. */
  | { kind: 'none' }
  /** A deploy is in flight for one of the project's targets: the button attaches to it. */
  | { kind: 'deploying'; targetId: TargetId; deployId: string; label: string }
  /** One candidate: click starts it. `live` = prod, which is what makes it the accent button. */
  | { kind: 'single'; targetId: TargetId; label: string; live: boolean }
  /** Several candidates: click opens the picker. */
  | { kind: 'menu'; label: string; live: boolean; options: DeployOption[] }
  /** The project has targets, but none has a deploy verb or a deploy command yet: click opens the setup modal. */
  | { kind: 'setup' };

/**
 * What the workspace deploy button shows for a project (owner request: "clearly shows which target").
 *
 * Deployable = a built-in verb or the user's own deploy command (`isDeployableTarget`). Prod targets win: with one, the button is
 * `Deploy to live · Vercel prod`; with several, a picker. Only non-prod deployables → `Deploy · Vercel preview`.
 * While a deploy runs for any of the project's targets the button reports it instead, so the state survives the
 * modal being closed.
 */
export const deployButtonState = (model: ReadModel, projectId: ProjectId): DeployButtonState => {
  const own = rows(model.targets).filter((t) => t.projectId === projectId);
  const deployable = own.filter(isDeployableTarget);
  if (deployable.length === 0) return own.length === 0 ? { kind: 'none' } : { kind: 'setup' };

  const active = Object.values(model.deploys)
    .filter((d) => d.projectId === projectId && isDeployActive(d))
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  if (active !== undefined) {
    const target = model.targets.byId[active.targetId];
    return {
      kind: 'deploying',
      targetId: active.targetId,
      deployId: active.deployId,
      label: fill(copy.deploy.deploying, { target: target === undefined ? '' : deployTargetLabel(target) }),
    };
  }

  const prod = deployable.filter((t) => t.env === 'prod');
  const live = prod.length > 0;
  const candidates = live ? prod : deployable;
  const first = candidates[0];
  if (candidates.length === 1 && first !== undefined) {
    return {
      kind: 'single',
      targetId: first.id,
      live,
      label: fill(live ? copy.deploy.toLive : copy.deploy.button, { target: deployTargetLabel(first) }),
    };
  }
  return {
    kind: 'menu',
    live,
    label: copy.deploy.pick,
    options: candidates.map((t) => ({
      targetId: t.id,
      label: deployTargetLabel(t),
      name: t.name,
      env: t.env,
      prod: t.env === 'prod',
    })),
  };
};

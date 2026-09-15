import {
  copy,
  fill,
  isDeployActive,
  isDeployableTarget,
  rows,
  type ProjectId,
  type ReadModel,
  type SessionId,
  type Target,
  type TargetId,
} from '@styx/core';
import { learnKey, learningSession } from '../abilities/learn';

/** How a target is named wherever the deploy button, toast and status bar mention it: `Vercel prod`. */
export const deployTargetLabel = (t: Pick<Target, 'name' | 'env'>): string => `${t.name} ${t.env}`;

export interface DeployOption {
  targetId: TargetId;
  label: string;
  name: string;
  env: string;
  prod: boolean;
  /** Styx has no command for this target yet: choosing it hands the first deploy to the agent. */
  learn: boolean;
}

export type DeployButtonState =
  /** No target in the project: the button connects one. */
  | { kind: 'none' }
  /** A deploy is in flight for one of the project's targets: the button attaches to it. */
  | { kind: 'deploying'; targetId: TargetId; deployId: string; label: string }
  /** The agent is working out (and running) the first deploy to a target in chat: the button opens that chat. */
  | { kind: 'learning'; targetId: TargetId; sessionId: SessionId; label: string }
  /** One candidate: click deploys (`learn` = the agent does it first and teaches Styx). `live` = prod → accent. */
  | { kind: 'single'; targetId: TargetId; label: string; live: boolean; learn: boolean }
  /** Several candidates: click opens the picker. */
  | { kind: 'menu'; label: string; live: boolean; options: DeployOption[] };

/**
 * What the workspace deploy button shows for a project (owner request: "clearly shows which target", and it works
 * the way asking an agent to deploy works).
 *
 * Every target of the project is a candidate. Prod targets win: with one, the button is `Deploy to live · Vercel
 * prod`; with several, a picker. Only non-prod targets → `Deploy · Vercel preview`. A target Styx can already
 * deploy to (built-in verb or remembered command, `isDeployableTarget`) deploys directly; any other hands the
 * first deploy to the agent, which teaches Styx the command for next time. While a deploy runs, or the agent is
 * working one out, the button reports that instead, so the state survives the modal or chat being closed.
 */
export const deployButtonState = (
  model: ReadModel,
  projectId: ProjectId,
  learning: Readonly<Record<string, SessionId>> = {},
): DeployButtonState => {
  const own = rows(model.targets).filter((t) => t.projectId === projectId);
  if (own.length === 0) return { kind: 'none' };

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

  for (const t of own) {
    const sessionId = learningSession(model, learning, learnKey.deploy(t.id));
    if (sessionId === null) continue;
    const session = model.sessions.byId[sessionId];
    const agent = session === undefined ? '' : copy.agentProducts[session.agent];
    return {
      kind: 'learning',
      targetId: t.id,
      sessionId,
      label: fill(copy.deploy.learning, { agent, target: deployTargetLabel(t) }),
    };
  }

  const prod = own.filter((t) => t.env === 'prod');
  const live = prod.length > 0;
  const candidates = live ? prod : own;
  const first = candidates[0];
  if (candidates.length === 1 && first !== undefined) {
    return {
      kind: 'single',
      targetId: first.id,
      live,
      learn: !isDeployableTarget(first),
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
      learn: !isDeployableTarget(t),
    })),
  };
};

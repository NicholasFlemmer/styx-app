import {
  copy,
  deployTargetLabel,
  deployTargetOptions,
  fill,
  isDeployActive,
  rows,
  type DeployTargetOption,
  type ProjectId,
  type ReadModel,
  type SessionId,
  type TargetId,
} from '@styx/core';
import { learnKey, learningSession } from '../abilities/learn';

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
  | { kind: 'menu'; label: string; live: boolean; options: DeployTargetOption[] };

/**
 * What the workspace deploy button shows for a project (owner request: "clearly shows which target", and it works
 * the way asking an agent to deploy works).
 *
 * Every target of the project is a candidate (`deployTargetOptions`, the same set the palette offers). With one,
 * the button names it: `Deploy to live · Vercel prod` for prod, `Deploy · Vercel preview` otherwise. With several,
 * the click opens a picker listing all of them, non-prod first and prod last (issue #9: it used to list only the
 * prod targets whenever there was one, hiding staging and preview). The picker has no default: a click never
 * deploys anywhere until a target is chosen. A target Styx can already deploy to (built-in verb or remembered
 * command) deploys directly; any other hands the first deploy to the agent, which teaches Styx the command for
 * next time. While a deploy runs, or the agent is working one out, the button reports that instead, so the state
 * survives the modal or chat being closed.
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

  const options = deployTargetOptions(model, projectId);
  const live = options.some((o) => o.prod);
  const [only] = options;
  if (options.length === 1 && only !== undefined) {
    return {
      kind: 'single',
      targetId: only.targetId,
      live,
      learn: only.learn,
      label: fill(live ? copy.deploy.toLive : copy.deploy.button, { target: only.label }),
    };
  }
  return { kind: 'menu', live, label: copy.deploy.pick, options };
};

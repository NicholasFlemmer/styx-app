import {
  agentSetupName,
  copy,
  fill,
  isAgentReady,
  isSetupAgent,
  readyAgents,
  type Agent,
  type ProjectId,
  type ReadModel,
} from '@styx/core';
import { Button } from '@styx/ui';
import { useCallback } from 'react';
import { command } from '../../state/commands';
import { useModel, useUi } from '../../state/hooks';
import s from './AgentProblemRow.module.css';

type Props = {
  agent: Agent;
  problem: 'signed-out' | 'limit';
  /** The row's sentence ("Claude is signed out."). */
  text: string;
  projectId: ProjectId;
  /** The last thing the person asked, for "Send it to … instead". */
  retryText: string;
};

/**
 * When an agent's account stops it mid-task (owner request, design frame 4): one plain sentence and the fix in the
 * chat, not the CLI's error text. Signed out → Sign in to it (the setup card runs the sign-in; the message goes out
 * again once it is back). Either way, another agent that is ready can take the same ask as a new task. Once the
 * agent is signed in again the sign-in button goes.
 */
export function AgentProblemRow({ agent, problem, text, projectId, retryText }: Props) {
  const pushOverlay = useUi((u) => u.pushOverlay);
  const openNewTask = useUi((u) => u.openNewTask);
  const back = useModel(useCallback((m: ReadModel) => agent !== 'shell' && isAgentReady(m, agent), [agent]));
  const other = useModel(
    useCallback((m: ReadModel) => readyAgents(m).find((a) => a !== agent) ?? null, [agent]),
  );
  if (agent === 'shell') return null;
  const name = agentSetupName(agent);
  // A card agent's setup run signs in by itself; any other agent signs in from the Connect agent modal's tools.
  const signIn = () => {
    if (isSetupAgent(agent)) void command('agent.setUp', { agent, update: false });
    pushOverlay({ kind: 'modal', modal: 'connect-agent', agent });
  };
  return (
    <div className={s['row']} data-agent-problem={problem} role="status">
      <b>{text}</b>
      <span className={s['body']}>
        {problem === 'signed-out' ? copy.agentSetup.chat.signedOutBody : copy.agentSetup.chat.limitBody}
      </span>
      {(problem === 'signed-out' && !back) || other !== null ? (
        <div className={s['actions']}>
          {problem === 'signed-out' && !back ? (
            <Button variant="accent" onClick={signIn} data-agent-problem-sign-in="true">
              {fill(copy.agentSetup.chat.signIn, { name })}
            </Button>
          ) : null}
          {other !== null ? (
            <button
              type="button"
              className={s['link']}
              onClick={() => openNewTask(projectId, retryText)}
              data-agent-problem-elsewhere={other}
            >
              {fill(copy.agentSetup.chat.elsewhere, { name: copy.agentSetup.names[other] })}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

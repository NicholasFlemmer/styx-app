import { copy, fill, type Agent, type ProjectId } from '@styx/core';
import { Button, Modal } from '@styx/ui';
import { useUi } from '../../state/hooks';

export interface ConnectAgentModalProps {
  id: string;
  agent: Agent;
  /** Re-opens the Spawn modal for that project when this one closes (the Spawn row's "Fix connection"). */
  returnTo?: { modal: 'spawn'; projectId: ProjectId };
}

/**
 * Connect agent (owner addition): verify / sign in for one agent CLI. Placeholder until WP1 lands; it only closes
 * (and returns to Spawn when asked) so the overlay payload is wired end to end.
 */
export function ConnectAgentModal({ id, agent, returnTo }: ConnectAgentModalProps) {
  const popOverlay = useUi((u) => u.popOverlay);
  const pushOverlay = useUi((u) => u.pushOverlay);
  const close = () => {
    popOverlay(id);
    if (returnTo !== undefined) pushOverlay({ kind: 'modal', modal: 'spawn', projectId: returnTo.projectId });
  };
  return (
    <Modal
      width={560}
      title={fill(copy.agentsPage.connect.title, { agent: copy.agentProducts[agent] })}
      onClose={close}
      footer={
        <Button size="footer" variant="primary" onClick={close}>
          {copy.agentsPage.connect.done}
        </Button>
      }
    >
      <div>{fill(copy.agentsPage.connect.heading, { agent: copy.agentProducts[agent] })}</div>
    </Modal>
  );
}

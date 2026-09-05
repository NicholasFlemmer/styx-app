import { copy, fill, projectNameOf, type ProjectId, type Provider, type TargetId } from '@styx/core';
import { Button, Modal } from '@styx/ui';
import { useModel, useUi } from '../../state/hooks';

/** Placeholder until Phase 7 ports the spawn form: title + Cancel only. */
export function SpawnModal({ id, projectId }: { id: string; projectId: ProjectId }) {
  const popOverlay = useUi((s) => s.popOverlay);
  const project = useModel((m) => projectNameOf(m, projectId));
  const close = () => popOverlay(id);
  return (
    <Modal
      width={600}
      title={fill(copy.spawn.title, { project })}
      onClose={close}
      escapeEnabled={false}
      footer={
        <Button size="footer" variant="ghost" onClick={close}>
          {copy.spawn.cancel}
        </Button>
      }
    >
      <span className="t-label">{copy.spawn.firstMessage}</span>
    </Modal>
  );
}

/** Placeholder until Phase 7 ports the new-project form. */
export function NewProjectModal({ id }: { id: string }) {
  const popOverlay = useUi((s) => s.popOverlay);
  const close = () => popOverlay(id);
  return (
    <Modal
      width={600}
      title={copy.newProject.title}
      onClose={close}
      escapeEnabled={false}
      footer={
        <Button size="footer" variant="ghost" onClick={close}>
          {copy.general.cancel}
        </Button>
      }
    >
      <span className="t-label">{copy.newProject.startFrom}</span>
    </Modal>
  );
}

/** Placeholder until Phase 6 ports the connect flow. */
export function ConnectModal({ id }: { id: string; projectId?: ProjectId | null; provider?: Provider | undefined; targetId?: TargetId | undefined }) {
  const popOverlay = useUi((s) => s.popOverlay);
  const close = () => popOverlay(id);
  return (
    <Modal
      width={560}
      title={fill(copy.connect.title, { step: copy.connect.stepPick })}
      onClose={close}
      escapeEnabled={false}
      bodyPad="20px 16px"
      footer={
        <Button size="footer" variant="ghost" onClick={close}>
          {copy.general.cancel}
        </Button>
      }
    >
      <span className="t-label">{copy.connect.stepPick}</span>
    </Modal>
  );
}

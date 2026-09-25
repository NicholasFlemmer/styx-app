import { copy, fill, rows, type ReadModel } from '@styx/core';
import { Button, Modal } from '@styx/ui';
import { useEffect, useRef } from 'react';
import { command } from '../../state/commands';
import { useModel, useUi } from '../../state/hooks';
import s from './UpdateModal.module.css';

export interface UpdateModalProps {
  id: string;
}

const selectUpdate = (m: ReadModel) => m.update;
const selectWorking = (m: ReadModel): number =>
  rows(m.sessions).filter((x) => x.archivedAt === null && (x.state === 'working' || x.state === 'needs-you'))
    .length;

/**
 * An update was found (owner request, #119: "not obvious enough"): a dialog says so at once, once per version, with
 * the download's progress; Restart to update lights up when it is done. Later closes it; the banner stays once the
 * update is ready.
 */
export function UpdateModal({ id }: UpdateModalProps) {
  const update = useModel(selectUpdate);
  const working = useModel(selectWorking);
  const popOverlay = useUi((u) => u.popOverlay);
  const close = () => popOverlay(id);
  const ready = update.status === 'ready';
  const gone = (update.status !== 'ready' && update.status !== 'downloading') || update.next === null;
  useEffect(() => {
    if (gone) popOverlay(id);
  }, [gone, id, popOverlay]);
  if (gone) return null;
  return (
    <Modal
      width={560}
      title={fill(ready ? copy.update.modal.title : copy.update.modal.available, {
        version: update.next ?? '',
      })}
      onClose={close}
      bodyPad="20px 16px"
      footer={
        <>
          <Button size="footer" variant="ghost" onClick={close} data-update-later="true">
            {copy.update.modal.later}
          </Button>
          <Button
            size="footer"
            variant="primary"
            disabled={!ready}
            onClick={() => void command('update.install', {})}
            data-update-restart="true"
          >
            {copy.update.restart}
          </Button>
        </>
      }
    >
      <div className={s['body']} data-update-modal="true">
        <p className={s['lead']} data-update-phase={ready ? 'ready' : 'downloading'}>
          {ready
            ? copy.update.modal.lead
            : fill(copy.update.modal.downloading, { percent: update.percent ?? 0 })}
        </p>
        {working > 0 && <p className={s['busy']}>{fill(copy.update.modal.busy, { n: working })}</p>}
      </div>
    </Modal>
  );
}

/**
 * Opens the update dialog once per downloaded version (Shell). `useRef` keeps the versions already shown for this
 * run of the app; a restart that did not install shows it again, which is the point.
 */
export function useUpdatePrompt(): void {
  const update = useModel(selectUpdate);
  const pushOverlay = useUi((u) => u.pushOverlay);
  const shown = useRef(new Set<string>());
  // As soon as an update is found (it downloads straight away), not only once it is ready: it must be obvious.
  const found = update.status === 'downloading' || update.status === 'ready' ? update.next : null;
  useEffect(() => {
    if (found === null || shown.current.has(found)) return;
    shown.current.add(found);
    pushOverlay({ kind: 'modal', modal: 'update' });
  }, [found, pushOverlay]);
}

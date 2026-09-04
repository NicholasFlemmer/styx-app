import {
  branchOf,
  copy,
  fill,
  projectNameOf,
  rows,
  toastFor,
  type AskId,
  type ProjectId,
  type SessionId,
} from '@styx/core';
import { motion } from '@styx/tokens';
import { Toast } from '@styx/ui';
import { useEffect } from 'react';
import { findOverlay, type Overlay, type ToastPayload } from '../../overlays/stack';
import { onEvent } from '../../state/bridge';
import { command } from '../../state/commands';
import { useUi, useUiShallow } from '../../state/hooks';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import s from './ToastHost.module.css';

export interface AskToastProps {
  id: string;
  askId: AskId;
  sessionId: SessionId;
  projectId: ProjectId;
}

/** Needs-you toast (spec §10 Toast): copy from core `toastFor`; Review opens the session + sheet, Later defers. */
export function AskToast({ id, askId, sessionId, projectId }: AskToastProps) {
  const model = useReadModel((st) => st.model);
  const popOverlay = useUi((st) => st.popOverlay);
  const openSession = useUi((st) => st.openSession);
  const pushOverlay = useUi((st) => st.pushOverlay);
  const ask = model.pendingAsks.byId[askId];
  const session = model.sessions.byId[sessionId];
  const grantToast = ask?.grantId != null ? toastFor(model, ask.grantId) : null;
  const agent = session === undefined ? copy.general.none : copy.agents[session.agent];
  const title = grantToast?.title ?? fill(copy.toast.osTitle, { agent });
  const detail =
    grantToast?.meta ??
    (session === undefined ? undefined : `${projectNameOf(model, projectId)} · ${branchOf(model, session)}`);

  const review = () => {
    popOverlay(id);
    openSession(projectId, sessionId);
    if (ask !== undefined && ask.kind === 'grant') {
      pushOverlay({ kind: 'sheet', sheet: 'grant', sessionId, askId });
    }
  };
  const later = () => {
    const notification = rows(model.notifications).find((n) => n.askId === askId && n.kind === 'needs-you');
    void command('notify.later', { notificationId: notification?.id ?? askId });
    popOverlay(id);
  };

  return (
    <Toast
      heading={copy.toast.header}
      meta={copy.toast.source}
      title={title}
      detail={detail}
      ttl={motion.toastTtl}
      onDismiss={() => popOverlay(id)}
      actions={[
        { label: copy.toast.review, onClick: review, primary: true },
        { label: copy.toast.later, onClick: later },
      ]}
    />
  );
}

function ErrorToast({ id, code, message }: { id: string; code: string; message: string }) {
  const popOverlay = useUi((st) => st.popOverlay);
  return (
    <Toast
      heading={code}
      meta={copy.toast.source}
      title={message}
      ttl={motion.toastTtl}
      onDismiss={() => popOverlay(id)}
    />
  );
}

const renderToast = (overlay: Extract<Overlay, { kind: 'toast' }>) => {
  const t: ToastPayload = overlay.toast;
  return t.kind === 'ask' ? (
    <AskToast id={overlay.id} askId={t.askId} sessionId={t.sessionId} projectId={t.projectId} />
  ) : (
    <ErrorToast id={overlay.id} code={t.code} message={t.message} />
  );
};

/** Listens for `ask.opened` and stacks toasts top-right (340px, right 16, top 52). Respects DND. */
export function ToastHost() {
  const toasts = useUiShallow((st) => st.overlays.filter((o) => o.kind === 'toast'));
  useEffect(
    () =>
      onEvent('ask.opened', ({ askId, sessionId, projectId }) => {
        const ui = useUiStore.getState();
        if (useReadModel.getState().model.settings.app.dnd) return;
        const existing = findOverlay(ui.overlays, 'toast');
        if (existing !== null && existing.toast.kind === 'ask' && existing.toast.askId === askId) return;
        ui.pushOverlay({ kind: 'toast', toast: { kind: 'ask', askId, sessionId, projectId } });
      }),
    [],
  );
  return (
    <div className={s['host']} aria-live="polite">
      {toasts.map((o, i) => (
        <div key={o.id} className={s['slot']} style={{ transform: `translateY(${i * 130}px)` }}>
          {renderToast(o)}
        </div>
      ))}
    </div>
  );
}

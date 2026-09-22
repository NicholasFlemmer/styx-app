import {
  branchOf,
  copy,
  fill,
  isDeployActive,
  projectNameOf,
  rows,
  toastFor,
  type AskId,
  type ProjectId,
  type SessionId,
  type TargetId,
} from '@styx/core';
import { motion, space } from '@styx/tokens';
import { Toast } from '@styx/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { invokerOf, rememberInvoker, type Overlay, type ToastPayload } from '../../overlays/stack';
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
    // Focus return chains through the toast (spec §9 "Esc returns focus to the invoker"): the sheet inherits
    // whatever had focus when the toast appeared, since the toast itself is gone by the time the sheet closes.
    const invoker = invokerOf(id);
    popOverlay(id);
    openSession(projectId, sessionId);
    if (ask !== undefined && ask.kind === 'grant') {
      const sheetId = pushOverlay({ kind: 'sheet', sheet: 'grant', sessionId, askId });
      if (invoker !== null) rememberInvoker(sheetId, invoker);
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
      data-toast="needs-you"
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
      data-toast="error"
    />
  );
}

/** A confirmation with nothing to do (skill installed / removed): heading, source meta and one line. */
function InfoToast({ id, heading, title }: { id: string; heading: string; title: string }) {
  const popOverlay = useUi((st) => st.popOverlay);
  return (
    <Toast
      heading={heading}
      meta={copy.toast.source}
      title={title}
      ttl={motion.toastTtl}
      onDismiss={() => popOverlay(id)}
      data-toast="info"
    />
  );
}

/**
 * A deploy finished while its modal was closed (owner request: progress must not depend on the modal). The row
 * in `model.deploys` is the source: succeeded / failed, the CLI's exit code or the error, and "Show output"
 * re-opens the modal attached to that deploy's terminal.
 */
export function DeployToast({
  id,
  deployId,
  targetId,
}: {
  id: string;
  deployId: string;
  targetId: TargetId;
}) {
  const model = useReadModel((st) => st.model);
  const popOverlay = useUi((st) => st.popOverlay);
  const pushOverlay = useUi((st) => st.pushOverlay);
  const target = model.targets.byId[targetId];
  const deploy = model.deploys[deployId];
  const label = target === undefined ? '' : `${target.name} ${target.env}`;
  const ok = deploy?.phase === 'succeeded';
  const detail =
    deploy?.error ??
    (deploy?.exitCode != null && deploy.exitCode !== 0
      ? fill(copy.deploy.exitCode, { code: String(deploy.exitCode) })
      : undefined);
  const showOutput = () => {
    const invoker = invokerOf(id);
    popOverlay(id);
    const modalId = pushOverlay({ kind: 'modal', modal: 'deploy', targetId, deployId });
    if (invoker !== null) rememberInvoker(modalId, invoker);
  };
  return (
    <Toast
      heading={fill(copy.deploy.title, { target: label })}
      meta={copy.toast.source}
      title={fill(ok ? copy.deploy.deployed : copy.deploy.deployFailed, { target: label })}
      detail={detail}
      ttl={motion.toastTtl}
      onDismiss={() => popOverlay(id)}
      actions={[{ label: copy.deploy.showOutput, onClick: showOutput, primary: true }]}
      data-deploy-toast={ok ? 'succeeded' : 'failed'}
    />
  );
}

const renderToast = (overlay: Extract<Overlay, { kind: 'toast' }>) => {
  const t: ToastPayload = overlay.toast;
  switch (t.kind) {
    case 'deploy':
      return <DeployToast id={overlay.id} deployId={t.deployId} targetId={t.targetId} />;
    case 'ask':
      return <AskToast id={overlay.id} askId={t.askId} sessionId={t.sessionId} projectId={t.projectId} />;
    case 'error':
      return <ErrorToast id={overlay.id} code={t.code} message={t.message} />;
    case 'info':
      return <InfoToast id={overlay.id} heading={t.heading} title={t.title} />;
  }
};

/** Vertical gap between stacked toasts. */
const TOAST_GAP = space.scale[2];

interface ToastSlotProps {
  overlay: Extract<Overlay, { kind: 'toast' }>;
  offset: number;
  onHeight: (id: string, height: number) => void;
}

/** One stacked toast; reports its rendered height so the next slot starts below it. */
function ToastSlot({ overlay, offset, onHeight }: ToastSlotProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current?.firstElementChild;
    if (!(el instanceof HTMLElement)) return;
    const report = () => onHeight(overlay.id, el.offsetHeight);
    report();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [overlay.id, onHeight]);
  return (
    <div ref={ref} className={s['slot']} style={{ transform: `translateY(${offset}px)` }}>
      {renderToast(overlay)}
    </div>
  );
}

/** Listens for `ask.opened` and stacks toasts top-right (340px, right 16, top 52), each below the previous one. Respects DND. */
export function ToastHost() {
  const toasts = useUiShallow((st) => st.overlays.filter((o) => o.kind === 'toast'));
  const [heights, setHeights] = useState<Record<string, number>>({});
  const onHeight = useCallback(
    (id: string, height: number) =>
      setHeights((prev) => (prev[id] === height ? prev : { ...prev, [id]: height })),
    [],
  );
  useEffect(
    () =>
      onEvent('ask.opened', ({ askId, sessionId, projectId }) => {
        const ui = useUiStore.getState();
        if (useReadModel.getState().model.settings.app.dnd) return;
        // One toast per ask: `ask.opened` can arrive more than once (a window reconnect, a re-published ask),
        // and only the newest toast was checked before, so a second copy stacked under any other toast.
        const already = ui.overlays.some(
          (o) => o.kind === 'toast' && o.toast.kind === 'ask' && o.toast.askId === askId,
        );
        if (already) return;
        ui.pushOverlay({ kind: 'toast', toast: { kind: 'ask', askId, sessionId, projectId } });
      }),
    [],
  );
  // An ask answered anywhere else (the board, the chat, the inbox, a Mod+⏎) takes its toast with it: a "needs
  // you" that has been dealt with is not news, and Review on it would open a settled bubble.
  useEffect(
    () =>
      useReadModel.subscribe((st, prev) => {
        if (st.model.pendingAsks === prev.model.pendingAsks) return;
        const ui = useUiStore.getState();
        for (const o of ui.overlays) {
          if (o.kind !== 'toast' || o.toast.kind !== 'ask') continue;
          const ask = st.model.pendingAsks.byId[o.toast.askId];
          if (ask === undefined || ask.state !== 'open') ui.popOverlay(o.id);
        }
      }),
    [],
  );
  // A deploy row going active → succeeded/failed with no deploy modal open for it gets a finish toast. Cancelled
  // is the user's own doing and rows that arrive already finished (a fresh snapshot) are history, not news.
  useEffect(
    () =>
      useReadModel.subscribe((st, prev) => {
        if (st.model.deploys === prev.model.deploys) return;
        if (st.model.settings.app.dnd) return;
        for (const [deployId, d] of Object.entries(st.model.deploys)) {
          const before = prev.model.deploys[deployId];
          if (before === undefined || !isDeployActive(before) || isDeployActive(d)) continue;
          if (d.phase === 'cancelled') continue;
          const ui = useUiStore.getState();
          const modalOpen = ui.overlays.some(
            (o) =>
              o.kind === 'modal' &&
              o.modal === 'deploy' &&
              (o.deployId === deployId || (o.deployId === undefined && o.targetId === d.targetId)),
          );
          if (modalOpen) continue;
          const shown = ui.overlays.some(
            (o) => o.kind === 'toast' && o.toast.kind === 'deploy' && o.toast.deployId === deployId,
          );
          if (shown) continue;
          ui.pushOverlay({ kind: 'toast', toast: { kind: 'deploy', deployId, targetId: d.targetId } });
        }
      }),
    [],
  );
  // Each Toast is its own `role=status` live region; no aria-live on the host (it would announce twice).
  // Each toast starts below the previous one's rendered height (+ gap); unmeasured toasts count as 0 until they report.
  const offsets: number[] = [];
  for (let i = 0; i < toasts.length; i += 1) {
    const prev = toasts[i - 1];
    offsets.push(prev === undefined ? 0 : (offsets[i - 1] ?? 0) + (heights[prev.id] ?? 0) + TOAST_GAP);
  }
  return (
    <div className={s['host']}>
      {toasts.map((o, i) => (
        <ToastSlot key={o.id} overlay={o} offset={offsets[i] ?? 0} onHeight={onHeight} />
      ))}
    </div>
  );
}

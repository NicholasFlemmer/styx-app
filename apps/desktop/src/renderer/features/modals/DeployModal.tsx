import { copy, fill, type DeployPhase, type TargetId } from '@styx/core';
import { Button, Modal } from '@styx/ui';
import { useEffect, useRef, useState } from 'react';
import { onEvent } from '../../state/bridge';
import { command } from '../../state/commands';
import { useModel, useUi } from '../../state/hooks';
import { useReadModel } from '../../state/read-model';
import { attachTerminal, detachTerminal } from '../terminal/terminal-registry';
import { createLoginTerminal } from './login-terminal';
import s from './DeployModal.module.css';

export interface DeployModalProps {
  id: string;
  targetId: TargetId;
  /** Attach to a deploy already running (from the workspace button / a finish toast) instead of starting one. */
  deployId?: string;
}

interface Local {
  phase: DeployPhase;
  error: string | null;
  exitCode: number | null;
  terminalId: string | null;
}

/**
 * Deploy progress. Until now the palette's "Deploy … → …" row navigated and did nothing, so a deploy had no
 * feedback because there was no deploy.
 *
 * Two things are shown, because a deploy fails in two quite different ways: the phase (asking for access, which
 * is where MFA appears, then running) and the CLI's own output, streamed from the same pty the rest of the app
 * uses. Without the phase line an MFA prompt looks like a hang; without the output a build failure is invisible.
 *
 * The row in `model.deploys` is what is rendered once the deploy has an id — given up front when the modal
 * re-opens on a running deploy, or returned by `deploy.start`. Until then (and if the start itself is refused)
 * the `deploy.progress` events fill in, so nothing is lost in the gap before the id is known.
 */
export function DeployModal({ id, targetId, deployId: attachId }: DeployModalProps) {
  const popOverlay = useUi((u) => u.popOverlay);
  const target = useModel((m) => m.targets.byId[targetId] ?? null);
  const [deployId, setDeployId] = useState<string | null>(attachId ?? null);
  const row = useReadModel((st) => (deployId === null ? null : (st.model.deploys[deployId] ?? null)));
  const [local, setLocal] = useState<Local>({
    phase: 'requesting-grant',
    error: null,
    exitCode: null,
    terminalId: null,
  });
  const host = useRef<HTMLDivElement>(null);

  const phase = row?.phase ?? local.phase;
  const error = row?.error ?? local.error;
  const exitCode = row?.exitCode ?? local.exitCode;
  const terminalId = row?.terminalId ?? local.terminalId;

  // Start, unless we were handed a running deploy to attach to.
  useEffect(() => {
    if (attachId !== undefined) return;
    let cancelled = false;
    void command('deploy.start', { targetId }).then((r) => {
      if (cancelled) return;
      if (r.ok) setDeployId(r.value.deployId);
      else setLocal((l) => ({ ...l, phase: 'failed', error: r.error.message }));
    });
    return () => {
      cancelled = true;
    };
  }, [targetId, attachId]);

  // Event fallback: before the id is known any progress for this target is ours; afterwards only our own.
  useEffect(
    () =>
      onEvent('deploy.progress', (e) => {
        if (deployId === null ? e.targetId !== targetId : e.deployId !== deployId) return;
        setLocal((l) => ({
          phase: e.phase,
          error: e.error,
          exitCode: e.exitCode,
          terminalId: e.terminalId ?? l.terminalId,
        }));
      }),
    [deployId, targetId],
  );

  // The CLI's output, for the deploy's terminal whichever way we learned its id.
  useEffect(() => {
    const el = host.current;
    if (terminalId === null || el === null) return;
    const t = createLoginTerminal(terminalId);
    attachTerminal(t, el);
    return () => {
      detachTerminal(t);
      t.term.dispose();
    };
  }, [terminalId]);

  const done = phase === 'succeeded' || phase === 'failed' || phase === 'cancelled';
  const close = () => popOverlay(id);

  return (
    <Modal
      width={560}
      title={fill(copy.deploy.title, { target: target === null ? '' : `${target.name} ${target.env}` })}
      onClose={close}
      footer={
        <>
          {!done && (
            <Button
              size="footer"
              variant="secondary"
              onClick={() => {
                if (deployId !== null) void command('deploy.cancel', { deployId });
              }}
            >
              {copy.deploy.cancel}
            </Button>
          )}
          <Button size="footer" variant="primary" onClick={close}>
            {copy.deploy.close}
          </Button>
        </>
      }
    >
      <div className={s['status']} data-phase={phase} data-deploy-phase={phase}>
        <span className="t-label">{copy.deploy.phases[phase]}</span>
        {exitCode !== null && exitCode !== 0 && (
          <span className={s['exit']}>{fill(copy.deploy.exitCode, { code: String(exitCode) })}</span>
        )}
      </div>
      {error !== null && <div className={s['error']}>{error}</div>}
      <div ref={host} className={s['term']} data-deploy-terminal="true" />
    </Modal>
  );
}

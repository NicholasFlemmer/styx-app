import { copy, fill, type TargetId } from '@styx/core';
import { Button, Modal } from '@styx/ui';
import { useEffect, useRef, useState } from 'react';
import { onEvent } from '../../state/bridge';
import { command } from '../../state/commands';
import { useModel, useUi } from '../../state/hooks';
import { attachTerminal, detachTerminal, type TerminalEntry } from '../terminal/terminal-registry';
import { createLoginTerminal } from './login-terminal';
import s from './DeployModal.module.css';

type Phase = 'requesting-grant' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface DeployModalProps {
  id: string;
  targetId: TargetId;
  /** Attach to a deploy already running (from the workspace button / a finish toast) instead of starting one. */
  deployId?: string;
}

/**
 * Deploy progress. Until now the palette's "Deploy … → …" row navigated and did nothing, so a deploy had no
 * feedback because there was no deploy.
 *
 * Two things are shown, because a deploy fails in two quite different ways: the phase (asking for access, which
 * is where MFA appears, then running) and the CLI's own output, streamed from the same pty the rest of the app
 * uses. Without the phase line an MFA prompt looks like a hang; without the output a build failure is invisible.
 */
export function DeployModal({ id, targetId }: DeployModalProps) {
  const popOverlay = useUi((u) => u.popOverlay);
  const target = useModel((m) => m.targets.byId[targetId] ?? null);
  const [phase, setPhase] = useState<Phase>('requesting-grant');
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const deployId = useRef<string | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const entry = useRef<TerminalEntry | null>(null);

  useEffect(() => {
    let cancelled = false;
    const off = onEvent('deploy.progress', (e) => {
      if (deployId.current !== null && e.deployId !== deployId.current) return;
      setPhase(e.phase);
      setError(e.error);
      setExitCode(e.exitCode);
      if (e.terminalId !== null && entry.current === null && host.current !== null) {
        const t = createLoginTerminal(e.terminalId);
        entry.current = t;
        attachTerminal(t, host.current);
      }
    });
    void command('deploy.start', { targetId }).then((r) => {
      if (cancelled) return;
      if (r.ok) deployId.current = r.value.deployId;
      else {
        setPhase('failed');
        setError(r.error.message);
      }
    });
    return () => {
      cancelled = true;
      off();
      if (entry.current !== null) {
        detachTerminal(entry.current);
        entry.current.term.dispose();
        entry.current = null;
      }
    };
  }, [targetId]);

  const done = phase === 'succeeded' || phase === 'failed' || phase === 'cancelled';
  const close = () => popOverlay(id);

  return (
    <Modal
      width={560}
      title={fill(copy.deploy.title, { target: target?.name ?? '' })}
      onClose={close}
      footer={
        <>
          {!done && (
            <Button
              size="footer"
              variant="secondary"
              onClick={() => {
                if (deployId.current !== null) void command('deploy.cancel', { deployId: deployId.current });
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
      <div className={s['status']} data-phase={phase}>
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

import { copy, fill } from '@styx/core';
import { Button } from '@styx/ui';
import { useEffect, useRef, useState } from 'react';
import { onEvent } from '../../state/bridge';
import { command } from '../../state/commands';
import s from './GitSetupNote.module.css';

type Phase = 'idle' | 'installing' | 'failed' | 'ready';

/** How often a running install is checked for git, and for how long (Apple's dialog can take a while). */
const POLL_MS = 3_000;
const POLL_FOR_MS = 20 * 60_000;

type Props = {
  /** What the note says when git is missing; defaults to the general line about starting without it. */
  text?: string;
  /** Git turned up (after Install, or it was there all along once checked again). */
  onReady?: () => void;
};

/**
 * Git is not a requirement to start (owner request): where it matters, this says so and offers Install git, which
 * runs the OS's own installer (main picks it). Renders nothing while git is there; after an install it checks for
 * git every few seconds and says when it is ready, with no restart. An installer that stops offers the download
 * page instead.
 */
export const GitSetupNote = ({ text = copy.gitSetup.missing, onReady }: Props) => {
  const [status, setStatus] = useState<{ installed: boolean; installCommand: string | null } | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const terminal = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    void command('git.status', {}).then((r) => {
      if (live && r.ok) setStatus(r.value);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (phase !== 'installing') return;
    const started = Date.now();
    const t = window.setInterval(() => {
      void command('git.status', {}).then((r) => {
        if (!r.ok) return;
        if (r.value.installed) {
          setStatus(r.value);
          setPhase('ready');
        } else if (Date.now() - started > POLL_FOR_MS) setPhase('failed');
      });
    }, POLL_MS);
    return () => window.clearInterval(t);
  }, [phase]);

  useEffect(
    () =>
      onEvent('git.install', (e) => {
        if (e.terminalId !== terminal.current || e.status !== 'exited') return;
        // macOS hands over to Apple's dialog and exits 0 at once: keep checking. A non-zero exit is a stopped install.
        if (e.exitCode !== 0 && e.exitCode !== undefined && e.exitCode !== null) {
          setExitCode(e.exitCode);
          setPhase('failed');
        }
      }),
    [],
  );

  useEffect(() => {
    if (phase === 'ready') onReady?.();
    // Once per arrival of git, not again when the parent passes a new callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  if (status === null) return null;
  if (phase === 'ready')
    return (
      <p className={s['note']} role="status" data-git-setup="ready">
        {copy.gitSetup.ready}
      </p>
    );
  if (status.installed) return null;

  const install = async (download: boolean) => {
    const r = await command('git.install', { download });
    if (!r.ok || r.value.terminalId === null) return;
    terminal.current = r.value.terminalId;
    setExitCode(null);
    setPhase('installing');
  };

  return (
    <div className={s['note']} role="status" data-git-setup={phase}>
      <p className={s['text']}>
        {phase === 'installing'
          ? copy.gitSetup.installing
          : phase === 'failed'
            ? fill(copy.gitSetup.failed, { code: exitCode ?? '?' })
            : text}
      </p>
      {phase === 'idle' || phase === 'failed' ? (
        <div className={s['actions']}>
          <Button
            variant="secondary"
            onClick={() => void install(phase === 'failed' || status.installCommand === null)}
            data-git-install="true"
          >
            {phase === 'failed' || status.installCommand === null
              ? copy.gitSetup.download
              : copy.gitSetup.install}
          </Button>
          {phase === 'idle' && status.installCommand !== null ? (
            <span className={s['command']}>
              {fill(copy.gitSetup.runs, { command: status.installCommand })}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

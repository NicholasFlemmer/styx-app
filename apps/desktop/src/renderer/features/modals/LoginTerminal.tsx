import { useEffect, useRef } from 'react';
import { attachTerminal, detachTerminal } from '../terminal/terminal-registry';
import s from './ConnectModal.module.css';
import { createLoginTerminal, disposeLoginTerminal } from './login-terminal';

export interface LoginTerminalProps {
  /** The pty main spawned (`target.connect.cliLogin` / `agent.login` → `terminalId`). */
  terminalId: string;
  /** "Waiting for gcloud auth login…" / "claude auth login exited with code 1." (aria-live). */
  label: string;
}

/**
 * A CLI's login flow, inline (prototype terminal recipe at 130px): an xterm bound to the pty main spawned for the
 * login, focused so prompts can be answered; the label follows the `connect.cliLogin` / `agent.login` event.
 * Shared by the Connect target and Connect agent modals; the recipe lives in ConnectModal.module.css.
 */
export function LoginTerminal({ terminalId, label }: LoginTerminalProps) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (el === null) return;
    const entry = createLoginTerminal(terminalId);
    attachTerminal(entry, el);
    entry.term.focus();
    return () => {
      detachTerminal(entry);
      disposeLoginTerminal(entry);
    };
  }, [terminalId]);
  return (
    <div className={s['terminal']} data-login-terminal={terminalId}>
      <div className={s['terminalLabel']} aria-live="polite">
        {label}
      </div>
      <div ref={host} className={s['terminalHost']} />
    </div>
  );
}

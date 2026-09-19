import {
  cliIsManual,
  cliConnectionState,
  cliSearchedDirs,
  cliVersionLabel,
  copy,
  fill,
  installRecipes,
  type Agent,
  type CliInstall,
  type EventPayload,
  type ProjectId,
  type ReadModel,
} from '@styx/core';
import { Button, Input, Modal, StatusDot } from '@styx/ui';
import { useEffect, useRef, useState } from 'react';
import { onEvent } from '../../state/bridge';
import { command } from '../../state/commands';
import { useModel, useUi } from '../../state/hooks';
import s from './ConnectAgentModal.module.css';
import { LoginTerminal } from './LoginTerminal';

export interface ConnectAgentModalProps {
  id: string;
  agent: Agent;
  /** Re-opens the Spawn modal for that project when this one closes (the Spawn row's "Fix connection"). */
  returnTo?: { modal: 'spawn'; projectId: ProjectId };
}

/** A CLI command running in the inline terminal: the sign-in (`claude auth login`) or the installer (`curl … | bash`). */
interface Run {
  terminalId: string;
  /** What the terminal label names. */
  command: string;
  status: EventPayload<'agent.login'>['status'];
  exitCode: number | null;
}

type Identity = 'checking' | 'failed' | 'connected' | 'unverified' | 'signed-out';

/** Base name of the row's binary (`claude`, `cursor-agent`), the agent id before anything is detected. */
const cliNameOf = (agent: Agent, cli: CliInstall | undefined): string => {
  const base = cli?.binary
    ?.split(/[\\/]/)
    .filter((seg) => seg.length > 0)
    .pop();
  return base === undefined ? agent : base;
};

/**
 * Connect agent (owner addition; modal 560): verify / sign in for one agent CLI, app-wide. Opens with a fresh
 * `agent.verify`; the status row says where the CLI lives — or, for a CLI that is not on the machine, offers
 * `Install <cli>…` (the vendor's own command in the inline terminal, `agent.install`; #98), the install guide and
 * Locate binary, with a path-or-command field and the list of folders detection looked in underneath. The identity
 * row says who it is signed in as, and `Sign in with <cli>…` runs the CLI's own login inline (`agent.login`, the
 * pty in a LoginTerminal). Main re-detects / re-verifies when either exits, so the row here just follows the
 * model. Shell needs nothing. Done returns to the Spawn modal when `returnTo` is set.
 */
export function ConnectAgentModal({ id, agent }: ConnectAgentModalProps) {
  const popOverlay = useUi((u) => u.popOverlay);
  const platform = useUi((u) => u.platform);
  const cli = useModel((m: ReadModel) => m.discovery.clis.find((c) => c.agent === agent));
  // Opens checking: the page may be hours old, the CLI may have been signed in elsewhere.
  const [checking, setChecking] = useState(agent !== 'shell');
  /** The `agent.verify` command itself failing (main unreachable …); the CLI's own failure sits on the row. */
  const [commandError, setCommandError] = useState<string | null>(null);
  const [login, setLogin] = useState<Run | null>(null);
  const [install, setInstall] = useState<Run | null>(null);
  const [pathText, setPathText] = useState('');
  const [showWhere, setShowWhere] = useState(false);
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLDivElement>(null);

  const product = copy.agentProducts[agent];
  const cliName = cliNameOf(agent, cli);
  const shell = agent === 'shell';
  const installed = cli !== undefined && cli.found && cli.binary !== null;
  const state = cli === undefined ? 'missing' : cliConnectionState(cli);

  // `returnTo` is honoured by the store's popOverlay, so Esc and the backdrop hand back to Spawn as Done does.
  const close = () => popOverlay(id);

  const verify = async (): Promise<void> => {
    if (shell) return;
    setChecking(true);
    const r = await command('agent.verify', { agent });
    setCommandError(r.ok ? null : r.error.message);
    setChecking(false);
  };

  // The open-time verify; the row itself arrives through the `discovery.set` delta.
  useEffect(() => {
    if (shell) return;
    let live = true;
    void command('agent.verify', { agent }).then((r) => {
      if (!live) return;
      setCommandError(r.ok ? null : r.error.message);
      setChecking(false);
    });
    return () => {
      live = false;
    };
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startLogin = async (): Promise<void> => {
    if (shell || !installed || busy) return;
    setBusy(true);
    const r = await command('agent.login', { agent });
    setBusy(false);
    if (!r.ok) return;
    setLogin({ terminalId: r.value.terminalId, command: r.value.command, status: 'running', exitCode: null });
  };

  // `agent.login` drives the terminal label; a clean exit hides the terminal and main re-verifies the row.
  useEffect(() => {
    if (login === null) return;
    return onEvent('agent.login', (e) => {
      if (e.terminalId !== login.terminalId || e.status !== 'exited') return;
      const exitCode = e.exitCode ?? null;
      setLogin(exitCode === 0 ? null : { ...login, status: 'exited', exitCode });
      // A clean exit unmounts the terminal that had focus; the heading takes it so the dialog keeps it.
      if (exitCode === 0) heading.current?.focus();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [login?.terminalId]);

  const installGuide = () => void command('agent.installGuide', { agent });
  /**
   * OS file picker → `detect.setBinary`; the `discovery.set` delta fills the status row, then the CLI is checked.
   * A refused pick (a folder, a file that does not run, another agent's CLI) says why, right here, and remembers
   * nothing, so the user can pick again instead of being stuck with a binary that cannot sign in.
   */
  const [locateError, setLocateError] = useState<string | null>(null);
  const locateBinary = async () => {
    const r = await command('dialog.pickFile', { title: copy.errors.locateBinary });
    if (!r.ok || r.value.path === null) return;
    const set = await command('detect.setBinary', { agent, path: r.value.path });
    setLocateError(set.ok ? null : set.error.message);
    if (set.ok) await verify();
  };
  /** The path field: an absolute or `~/` path, or a bare command name main resolves on the shell PATH. */
  const applyPath = async () => {
    const value = pathText.trim();
    if (value === '' || busy) return;
    setBusy(true);
    const set = await command('detect.setBinary', { agent, path: value });
    setBusy(false);
    if (!set.ok) return;
    setPathText('');
    await verify();
  };
  /** `agent.install`: main runs the vendor's command in a pty; on exit it re-detects and re-verifies before `exited`. */
  const startInstall = async (): Promise<void> => {
    if (shell || installed || busy) return;
    setBusy(true);
    const r = await command('agent.install', { agent });
    setBusy(false);
    if (!r.ok) return;
    setInstall({
      terminalId: r.value.terminalId,
      command: r.value.command,
      status: 'running',
      exitCode: null,
    });
  };
  useEffect(() => {
    if (install === null) return;
    return onEvent('agent.install', (e) => {
      if (e.terminalId !== install.terminalId || e.status !== 'exited') return;
      const exitCode = e.exitCode ?? null;
      setInstall(exitCode === 0 ? null : { ...install, status: 'exited', exitCode });
      if (exitCode === 0) {
        heading.current?.focus();
        void verify();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [install?.terminalId]);
  /** The command Install would run on this platform (tooltip); null when no recipe applies here. */
  const recipe = installRecipes(agent, platform)[0] ?? null;
  const searched = cli === undefined ? [] : cliSearchedDirs(cli);
  /** Undo a located binary: detection is trusted again and the row follows the `discovery.set` delta. */
  const forgetBinary = async () => {
    setLocateError(null);
    const r = await command('detect.clearBinary', { agent });
    if (!r.ok) {
      setLocateError(r.error.message);
      return;
    }
    await verify();
  };
  const located = installed && cli !== undefined && cliIsManual(cli);

  const c = copy.agentsPage.connect;
  const identity: Identity = checking
    ? 'checking'
    : commandError !== null || (cli !== undefined && cli.verifyError !== null)
      ? 'failed'
      : state === 'connected'
        ? 'connected'
        : state === 'unverified'
          ? 'unverified'
          : 'signed-out';
  const identityText =
    identity === 'checking'
      ? fill(c.checking, { cli: cliName })
      : identity === 'failed'
        ? fill(c.checkFailed, { error: commandError ?? cli?.verifyError ?? copy.general.none })
        : identity === 'connected'
          ? cli?.account
            ? fill(c.signedInAs, { account: cli.account })
            : c.signedIn
          : identity === 'unverified'
            ? c.unverified
            : c.notSignedIn;
  const loginLabel =
    login === null
      ? null
      : login.status === 'running'
        ? fill(c.waiting, { command: login.command })
        : fill(c.loginFailed, { command: login.command, code: login.exitCode ?? copy.general.none });
  const installLabel =
    install === null
      ? null
      : install.status === 'running'
        ? fill(c.installing, { command: install.command })
        : fill(c.installFailed, { command: install.command, code: install.exitCode ?? copy.general.none });

  return (
    <Modal
      width={560}
      title={fill(c.title, { agent: product })}
      onClose={close}
      escapeEnabled={false}
      bodyPad="20px 16px"
      initialFocus={heading}
      footer={
        <>
          {!shell && installed ? (
            <Button
              size="footer"
              variant="secondary"
              disabled={checking}
              onClick={() => void verify()}
              data-agent-verify="true"
            >
              {c.verify}
            </Button>
          ) : null}
          <Button size="footer" variant="primary" onClick={close} data-agent-done="true">
            {c.done}
          </Button>
        </>
      }
    >
      <div ref={heading} tabIndex={-1} className={s['heading']}>
        {fill(c.heading, { agent: product })}
      </div>
      {shell ? (
        <div className={s['body']}>{c.shell}</div>
      ) : (
        <>
          <div className={s['body']}>{fill(c.body, { cli: cliName })}</div>
          <div className={s['status']} data-cli-installed={installed ? 'true' : 'false'}>
            <span className={s['statusText']}>
              {installed && cli !== undefined
                ? fill(c.installedLine, { version: cliVersionLabel(cli), location: cli.binary ?? '' })
                : fill(c.notInstalled, { cli: cliName })}
            </span>
            {installed ? null : (
              <>
                <button
                  type="button"
                  className={s['link']}
                  disabled={busy || checking || install?.status === 'running'}
                  title={recipe === null ? undefined : fill(c.installRuns, { command: recipe.command })}
                  onClick={() => void startInstall()}
                  data-agent-install="true"
                >
                  {fill(c.install, { cli: cliName })}
                </button>
                <button type="button" className={s['link']} onClick={installGuide}>
                  {copy.agentsPage.actions.installGuide}
                </button>
                <button type="button" className={s['link']} onClick={() => void locateBinary()}>
                  {copy.agentsPage.actions.locate}
                </button>
              </>
            )}
            {located ? (
              <button
                type="button"
                className={s['link']}
                onClick={() => void forgetBinary()}
                data-agent-forget="true"
              >
                {copy.agentsPage.actions.forget}
              </button>
            ) : null}
          </div>
          {installed ? null : (
            <>
              {install !== null && installLabel !== null ? (
                <LoginTerminal terminalId={install.terminalId} label={installLabel} />
              ) : null}
              <div className={s['pathRow']}>
                <Input
                  mono
                  {...(s['pathInput'] === undefined ? {} : { className: s['pathInput'] })}
                  aria-label={c.pathField}
                  placeholder={c.pathPlaceholder}
                  value={pathText}
                  disabled={busy || checking}
                  onChange={(e) => setPathText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    void applyPath();
                  }}
                  data-agent-path="true"
                />
                <button
                  type="button"
                  className={s['link']}
                  disabled={busy || checking || pathText.trim() === ''}
                  onClick={() => void applyPath()}
                >
                  {copy.agentsPage.actions.use}
                </button>
              </div>
              <div className={s['where']}>
                <span className={s['whereText']}>
                  {searched.length === 0 ? c.searchedNone : fill(c.searched, { n: searched.length })}
                </span>
                {searched.length > 0 ? (
                  <button
                    type="button"
                    className={s['link']}
                    aria-expanded={showWhere}
                    onClick={() => setShowWhere((v) => !v)}
                  >
                    {showWhere ? c.hideWhere : c.showWhere}
                  </button>
                ) : null}
              </div>
              {showWhere ? (
                <ul className={s['whereList']} data-agent-searched="true">
                  {searched.map((dir) => (
                    <li key={dir}>{dir}</li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
          {locateError !== null ? (
            <div className={s['locateError']} role="alert" data-locate-error="true">
              {locateError}
            </div>
          ) : null}
          {installed ? (
            <>
              <div className={s['identity']} aria-live="polite" data-agent-identity={identity}>
                <StatusDot tone="hollow" on={identity !== 'connected'} />
                <span className={s['identityText']}>{identityText}</span>
              </div>
              <button
                type="button"
                className={[s['link'], s['signIn']].join(' ')}
                disabled={busy || checking || login?.status === 'running'}
                onClick={() => void startLogin()}
                data-agent-sign-in="true"
              >
                {fill(c.signIn, { cli: cliName })}
              </button>
              {login !== null && loginLabel !== null ? (
                <LoginTerminal terminalId={login.terminalId} label={loginLabel} />
              ) : null}
            </>
          ) : null}
        </>
      )}
    </Modal>
  );
}

import {
  copy,
  fill,
  platformCopy,
  type EventPayload,
  type ProjectId,
  type Provider,
  type TargetId,
} from '@styx/core';
import { Button, ChipGroup, Field, Icon, Input, Label, Modal } from '@styx/ui';
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { onEvent } from '../../state/bridge';
import { command } from '../../state/commands';
import { useCopyPlatform, useUi } from '../../state/hooks';
import { useReadModel } from '../../state/read-model';
import s from './ConnectModal.module.css';
import { LoginTerminal } from './LoginTerminal';
import {
  CONNECT_ENVS,
  PROVIDERS,
  providerCli,
  cliSavePayload,
  cliStatusLine,
  defaultAccount,
  keyFormValid,
  methodLabel,
  methodOf,
  cliMethodLabel,
  primaryStepOf,
  sshFormValid,
  sshTargetName,
  type CliStatus,
  type ConnectStep,
  type KeyForm,
  sshPort,
  type SshForm,
} from './modals';

export interface ConnectModalProps {
  id: string;
  /** Project the target belongs to; falls back to the active project. */
  projectId?: ProjectId | null;
  /** Opens directly on this provider's method step (onboarding tiles, Reconnect banner). */
  provider?: Provider;
  /** Reconnect an existing target (its provider/env are pre-filled when the row is in the model). */
  targetId?: TargetId;
}

interface OAuthFlow {
  flowId: string;
  /** The placeholder target the flow made: the pasted token is saved against it. */
  targetId: TargetId;
  browserUrl: string | null;
  phase: EventPayload<'connect.progress'>['phase'];
  message: string | null;
}

interface CliLogin {
  terminalId: string;
  status: EventPayload<'connect.cliLogin'>['status'];
  exitCode: number | null;
}

type ConnectEnv = (typeof CONNECT_ENVS)[number];
const isConnectEnv = (v: string): v is ConnectEnv => (CONNECT_ENVS as readonly string[]).includes(v);

/**
 * Connect target (spec §4.10, modal 560): provider grid → per-provider step. The primary path is the provider's own
 * CLI (`target.connect.cliStatus` → accounts → `cliSave`; `cliLogin` runs the CLI's login in an inline terminal);
 * the OAuth / IAM-key / token forms sit under Advanced, SSH keeps its form. Secrets go straight into
 * `target.connect.*` inputs; nothing is echoed back.
 */
export function ConnectModal({
  id,
  projectId: projectIdProp,
  provider: providerProp,
  targetId,
}: ConnectModalProps) {
  const popOverlay = useUi((u) => u.popOverlay);
  const platform = useCopyPlatform();
  const activeProject = useUi((u) => u.projectId);
  const words = platformCopy(platform);
  const target = useReadModel((st) => (targetId === undefined ? undefined : st.model.targets.byId[targetId]));

  const projectId: ProjectId | null = projectIdProp ?? target?.projectId ?? activeProject;
  const initialProvider = target?.provider ?? providerProp ?? null;
  /** Reconnecting a CLI-backed target: the login terminal starts as the modal opens. */
  const reconnectCli = target !== undefined && target.authMethod === 'cli';
  const reconnectAccount = typeof target?.config['account'] === 'string' ? target.config['account'] : null;

  const [provider, setProvider] = useState<Provider>(initialProvider ?? 'vercel');
  const [step, setStep] = useState<ConnectStep>(
    initialProvider === null ? 'pick' : primaryStepOf(initialProvider),
  );
  const [env, setEnv] = useState<ConnectEnv>(
    target !== undefined && isConnectEnv(target.env) ? target.env : 'prod',
  );
  const [flow, setFlow] = useState<OAuthFlow | null>(null);
  const [token, setToken] = useState('');
  const [key, setKey] = useState<KeyForm>({ name: '', accessKey: '', secret: '' });
  const [ssh, setSsh] = useState<SshForm>({
    host: '',
    user: '',
    keyPath: '',
    port: '',
    passphrase: '',
  });
  const [cliStatus, setCliStatus] = useState<CliStatus | null>(null);
  const [account, setAccount] = useState<string | null>(reconnectAccount);
  const [name, setName] = useState(reconnectCli ? target.name : '');
  const [login, setLogin] = useState<CliLogin | null>(null);
  // A non-CLI target being reconnected opens straight on its legacy form (prototype: Reconnect → AWS key step).
  const [advanced, setAdvanced] = useState(target !== undefined && !reconnectCli);
  const [savedTargetId, setSavedTargetId] = useState<TargetId | null>(targetId ?? null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const firstTile = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLDivElement>(null);
  const firstInput = useRef<HTMLInputElement>(null);

  const cli = providerCli(provider) ?? '';
  const loginCommand = cliStatus?.loginCommand ?? `${cli} auth login`;

  const close = () => popOverlay(id);
  const back = () => {
    setStep('pick');
    setFlow(null);
    setLogin(null);
    setAdvanced(false);
    setStatus(null);
  };
  const pick = (p: Provider) => {
    setProvider(p);
    setStep(primaryStepOf(p));
    setFlow(null);
    setLogin(null);
    setAdvanced(false);
    setStatus(null);
    // What was typed for one provider must not sit in the next one's form (an AWS key in the GCP form).
    setToken('');
    setKey({ name: '', accessKey: '', secret: '' });
    setSsh({ host: '', user: '', keyPath: '', port: '', passphrase: '' });
  };

  // OAuth progress for the running flow: saved closes the modal, failed shows the message inline.
  useEffect(() => {
    if (flow === null) return;
    return onEvent('connect.progress', (e) => {
      if (e.flowId !== flow.flowId) return;
      if (e.phase === 'saved') {
        close();
        return;
      }
      setFlow((f) => (f === null ? f : { ...f, phase: e.phase, message: e.message }));
      if (e.phase === 'failed') setStatus(e.message);
    });
    // `close` is stable per overlay id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow?.flowId]);

  /** What the local CLI knows: installed + version, signed-in accounts (the active one preselected). */
  const refreshCliStatus = async (p: Provider): Promise<void> => {
    if (p === 'ssh') return;
    const r = await command('target.connect.cliStatus', { provider: p });
    if (!r.ok) {
      setCliStatus(null);
      return;
    }
    setCliStatus(r.value);
    setAccount((a) => (a !== null && r.value.accounts.some((x) => x.id === a) ? a : defaultAccount(r.value)));
  };

  useEffect(() => {
    if (step !== 'cli') return;
    let live = true;
    void (async () => {
      const r = await command('target.connect.cliStatus', { provider });
      if (!live) return;
      if (!r.ok) {
        setCliStatus(null);
        return;
      }
      setCliStatus(r.value);
      setAccount((a) =>
        a !== null && r.value.accounts.some((x) => x.id === a) ? a : defaultAccount(r.value),
      );
    })();
    return () => {
      live = false;
    };
  }, [step, provider]);

  const startLogin = async (forAccount: string | null): Promise<void> => {
    if (projectId === null || busy || provider === 'ssh') return;
    setBusy(true);
    setStatus(null);
    const r = await command('target.connect.cliLogin', {
      projectId,
      provider,
      ...(forAccount !== null ? { account: forAccount } : {}),
    });
    setBusy(false);
    if (!r.ok) return;
    setLogin({ terminalId: r.value.terminalId, status: 'running', exitCode: null });
  };

  // Reconnect of a CLI target: the login terminal is already running when the modal opens.
  useEffect(() => {
    if (!reconnectCli || projectId === null || provider === 'ssh') return;
    let live = true;
    void command('target.connect.cliLogin', {
      projectId,
      provider,
      ...(reconnectAccount !== null ? { account: reconnectAccount } : {}),
    }).then((r) => {
      if (live && r.ok) setLogin({ terminalId: r.value.terminalId, status: 'running', exitCode: null });
    });
    return () => {
      live = false;
    };
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `connect.cliLogin` drives the terminal label; on exit the accounts list is refreshed from `cliStatus`.
  useEffect(() => {
    if (login === null) return;
    return onEvent('connect.cliLogin', (e) => {
      if (e.terminalId !== login.terminalId) return;
      if (e.status === 'running') return;
      const exitCode = e.exitCode ?? null;
      setLogin(exitCode === 0 ? null : { ...login, status: 'exited', exitCode });
      if (exitCode !== 0 && exitCode !== null) {
        setStatus(fill(copy.connect.cli.loginFailed, { command: loginCommand, code: exitCode }));
      }
      void refreshCliStatus(provider);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [login?.terminalId, provider]);

  const connectCli = async () => {
    if (projectId === null || cliStatus === null || account === null || busy) return;
    setBusy(true);
    const r = await command(
      'target.connect.cliSave',
      cliSavePayload(projectId, provider, env, cliStatus, account, name),
    );
    setBusy(false);
    if (r.ok) close();
  };

  const startOauth = async () => {
    if (projectId === null || busy) return;
    setBusy(true);
    setStatus(null);
    const r = await command('target.connect.start', { projectId, provider, env });
    setBusy(false);
    if (!r.ok) return;
    setFlow({
      flowId: r.value.flowId,
      targetId: r.value.targetId,
      browserUrl: r.value.browserUrl,
      phase: 'waiting-browser',
      message: null,
    });
  };

  const saveToken = async () => {
    if (flow === null || token === '' || busy) return;
    setBusy(true);
    const r = await command('target.connect.saveToken', { targetId: flow.targetId, token });
    setBusy(false);
    if (r.ok) close();
  };

  /** Saves once, then reuses the target id for later tests / the final save. */
  const ensureSaved = async (): Promise<TargetId | null> => {
    if (savedTargetId !== null) return savedTargetId;
    if (projectId === null) return null;
    let r;
    if (step === 'ssh') {
      if (!sshFormValid(ssh)) return null;
      r = await command('target.connect.saveSsh', {
        projectId,
        name: sshTargetName(ssh),
        env,
        host: ssh.host.trim(),
        user: ssh.user.trim(),
        keyPath: ssh.keyPath.trim(),
        port: sshPort(ssh) ?? 22,
        ...(ssh.passphrase !== '' ? { passphrase: ssh.passphrase } : {}),
      });
    } else {
      if (!keyFormValid(key) || (provider !== 'aws' && provider !== 'gcp')) return null;
      r = await command('target.connect.saveKey', {
        projectId,
        provider,
        name: key.name.trim(),
        env,
        accessKey: key.accessKey.trim(),
        secret: key.secret,
        config: {},
      });
    }
    if (!r.ok) return null;
    const saved = r.value.targetId ?? null;
    setSavedTargetId(saved);
    return saved;
  };

  const test = async () => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    const tid = await ensureSaved();
    if (tid !== null) {
      const r = await command('target.test', { targetId: tid });
      if (r.ok)
        setStatus(
          r.value.message ?? (r.value.ok ? copy.audit.actions.connected : copy.audit.actions.disconnected),
        );
    }
    setBusy(false);
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    const tid = await ensureSaved();
    if (tid !== null) {
      await command('target.test', { targetId: tid });
      close();
    }
    setBusy(false);
  };

  const legacyMethod = methodOf(provider);
  const title = fill(copy.connect.title, {
    step:
      step === 'pick'
        ? copy.connect.stepPick
        : step === 'cli'
          ? advanced
            ? methodLabel(provider)
            : cliMethodLabel(provider)
          : methodLabel(provider),
  });
  const providerName = copy.providers[provider];
  const canSaveKey = keyFormValid(key) && projectId !== null && !busy;
  const canSaveSsh = sshFormValid(ssh) && projectId !== null && !busy;
  /** OS file picker for the key path (main-owned; the key file itself is never read here). */
  const browseKey = async () => {
    const r = await command('dialog.pickFile', { title: copy.connect.ssh.key, defaultPath: '~/.ssh' });
    if (!r.ok || r.value.path === null) return;
    const keyPath = r.value.path;
    setSsh((f) => ({ ...f, keyPath }));
  };
  const canConnectCli = projectId !== null && cliStatus !== null && account !== null && !busy;
  // GitHub runs the device flow by itself; every other provider's page opens in the browser and the token is
  // pasted here, so the field shows for them from the start of the flow.
  const tokenMode = flow !== null && (flow.browserUrl === null || provider !== 'github');
  const saveLabel = fill(copy.connect.key.save, { keychainShort: words.keychainShort });

  const envRow = (
    <div className={s['envRow']}>
      <Label>{copy.connect.environment}</Label>
      <ChipGroup
        layout="inline"
        size="env"
        className={s['envChips']}
        aria-label={copy.connect.environment}
        options={CONNECT_ENVS.map((e) => ({ value: e, label: e }))}
        value={env}
        onChange={(v) => setEnv(isConnectEnv(v) ? v : 'prod')}
      />
    </div>
  );
  const statusLine =
    status === null ? null : (
      <div className={s['status']} role="status">
        {status}
      </div>
    );
  const backButton = (
    <Button size="footer" variant="ghost" className={s['back']} onClick={back}>
      {copy.connect.back}
    </Button>
  );

  if (step === 'pick') {
    return (
      <Modal width={560} title={title} onClose={close} escapeEnabled={false} initialFocus={firstTile}>
        <div className={s['grid']} role="group" aria-label={copy.connect.stepPick}>
          {PROVIDERS.map((p, i) => (
            <button
              key={p}
              ref={i === 0 ? firstTile : undefined}
              type="button"
              className={s['tile']}
              data-provider={p}
              onClick={() => pick(p)}
            >
              <span className={s['tileName']}>{copy.providers[p]}</span>
              <Label>{methodLabel(p)}</Label>
            </button>
          ))}
        </div>
      </Modal>
    );
  }

  // --- Advanced (legacy) forms: OAuth / token for Vercel · Supabase · GitHub, IAM key for AWS · GCP -----------
  const oauthFooter = tokenMode ? (
    <Button size="footer" variant="primary" disabled={token === '' || busy} onClick={() => void saveToken()}>
      {saveLabel}
    </Button>
  ) : (
    <Button
      size="footer"
      variant="primary"
      disabled={projectId === null || busy}
      onClick={() => void startOauth()}
    >
      {copy.connect.oauth.open}
    </Button>
  );
  const oauthBody = (
    <>
      <div className={s['body']}>{fill(copy.connect.oauth.body, { keychainName: words.keychainName })}</div>
      {tokenMode ? (
        <TokenField value={token} onChange={setToken} />
      ) : (
        <div className={s['waiting']} aria-live="polite">
          <span>{copy.connect.oauth.waiting}</span>
          <span className={s['cursor']} aria-hidden="true" />
        </div>
      )}
    </>
  );
  const keyFooter = (
    <>
      <Button size="footer" variant="secondary" disabled={!canSaveKey} onClick={() => void test()}>
        {copy.connect.key.test}
      </Button>
      <Button size="footer" variant="primary" disabled={!canSaveKey} onClick={() => void save()}>
        {saveLabel}
      </Button>
    </>
  );
  const keyBody = (
    <>
      <div className={s['body']}>{fill(copy.connect.key.body, { keychainName: words.keychainName })}</div>
      <TextField
        label={copy.connect.key.name}
        value={key.name}
        onChange={(v) => setKey({ ...key, name: v })}
      />
      <TextField
        label={copy.connect.key.accessKey}
        value={key.accessKey}
        onChange={(v) => setKey({ ...key, accessKey: v })}
      />
      <TextField
        label={copy.connect.key.secret}
        masked
        value={key.secret}
        onChange={(v) => setKey({ ...key, secret: v })}
      />
    </>
  );

  if (step === 'cli') {
    const installed = cliStatus?.installed === true;
    const accounts = cliStatus?.accounts ?? [];
    const loginLabel =
      login === null
        ? null
        : login.status === 'running'
          ? fill(copy.connect.cli.waiting, { command: loginCommand })
          : fill(copy.connect.cli.loginFailed, {
              command: loginCommand,
              code: login.exitCode ?? copy.general.none,
            });
    return (
      <Modal
        width={560}
        title={title}
        onClose={close}
        escapeEnabled={false}
        bodyPad="20px 16px"
        initialFocus={heading}
        footer={
          <>
            {backButton}
            {advanced ? (
              legacyMethod === 'key' ? (
                keyFooter
              ) : (
                oauthFooter
              )
            ) : (
              <Button
                size="footer"
                variant="primary"
                disabled={!canConnectCli}
                onClick={() => void connectCli()}
                data-connect-cli="true"
              >
                {copy.connect.cli.connect}
              </Button>
            )}
          </>
        }
      >
        <div ref={heading} tabIndex={-1} className={s['providerName']}>
          {fill(copy.connect.cli.heading, { cli })}
        </div>
        <div className={s['body']}>{fill(copy.connect.cli.body, { cli })}</div>
        <div className={s['cliStatus']} data-cli-installed={installed ? 'true' : 'false'}>
          <span className={s['cliStatusText']}>{cliStatusLine(cli, cliStatus)}</span>
          {cliStatus !== null && !installed ? (
            // TODO(main): no open-URL command in the contract yet; the guide link stays disabled.
            <button type="button" className={s['link']} disabled title={copy.connect.cli.installGuide}>
              {copy.connect.cli.installGuide}
            </button>
          ) : null}
        </div>
        <div className={s['accounts']}>
          <Label as="div" id={`${id}-accounts`}>
            {copy.connect.cli.account}
          </Label>
          {accounts.length > 0 ? (
            <div role="radiogroup" aria-labelledby={`${id}-accounts`} className={s['accountList']}>
              {accounts.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  role="radio"
                  aria-checked={account === a.id}
                  data-inv={account === a.id ? 'true' : undefined}
                  className={s['account']}
                  onClick={() => setAccount(a.id)}
                >
                  <span className={s['accountLabel']}>{a.label}</span>
                  <span className={s['accountDetail']}>
                    {[a.detail, a.active ? copy.connect.cli.active : null].filter(Boolean).join(' · ')}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className={s['body']}>
              {cliStatus === null || installed
                ? fill(copy.connect.cli.notLoggedIn, { command: loginCommand })
                : fill(copy.connect.cli.notInstalled, { cli })}
            </div>
          )}
          <button
            type="button"
            className={s['link']}
            disabled={projectId === null || busy || !installed || login?.status === 'running'}
            onClick={() => void startLogin(null)}
          >
            {fill(copy.connect.cli.login, { cli })}
          </button>
        </div>
        {login !== null && loginLabel !== null ? (
          <LoginTerminal terminalId={login.terminalId} label={loginLabel} />
        ) : null}
        {envRow}
        {advanced ? null : (
          <TextField
            label={copy.connect.cli.name}
            hint={copy.connect.cli.nameOptional}
            value={name}
            onChange={setName}
          />
        )}
        <button
          type="button"
          className={s['disclosure']}
          aria-expanded={advanced}
          aria-controls={`${id}-advanced`}
          onClick={() => setAdvanced((a) => !a)}
        >
          <span className={s['disclosureLabel']}>{copy.connect.cli.advanced}</span>
          <Icon name="chevron" size={10} className={advanced ? s['chevronOpen'] : undefined} />
          <span className={s['disclosureHint']}>{copy.connect.cli.advancedHint}</span>
        </button>
        {advanced ? (
          <div id={`${id}-advanced`} className={s['advanced']} data-advanced-method={legacyMethod}>
            <div className={s['advancedTitle']}>
              {providerName} · {methodLabel(provider)}
            </div>
            {legacyMethod === 'key' ? keyBody : oauthBody}
          </div>
        ) : null}
        {statusLine}
      </Modal>
    );
  }

  return (
    <Modal
      width={560}
      title={title}
      onClose={close}
      escapeEnabled={false}
      bodyPad="20px 16px"
      initialFocus={firstInput}
      footer={
        <>
          {backButton}
          <Button size="footer" variant="secondary" disabled={!canSaveSsh} onClick={() => void test()}>
            {copy.connect.ssh.test}
          </Button>
          <Button size="footer" variant="primary" disabled={!canSaveSsh} onClick={() => void save()}>
            {copy.connect.ssh.save}
          </Button>
        </>
      }
    >
      <div className={s['providerName']}>{copy.providers.ssh}</div>
      <div className={s['two']}>
        <TextField
          label={copy.connect.ssh.host}
          value={ssh.host}
          onChange={(v) => setSsh({ ...ssh, host: v })}
        />
        <TextField
          label={copy.connect.ssh.user}
          value={ssh.user}
          onChange={(v) => setSsh({ ...ssh, user: v })}
        />
      </div>
      <div className={s['two']}>
        <TextField
          label={copy.connect.ssh.port}
          hint={copy.connect.ssh.portHint}
          value={ssh.port}
          onChange={(v) => setSsh({ ...ssh, port: v })}
        />
        <TextField
          label={copy.connect.ssh.passphrase}
          hint={copy.connect.ssh.passphraseHint}
          value={ssh.passphrase}
          masked
          onChange={(v) => setSsh({ ...ssh, passphrase: v })}
        />
      </div>
      <TextField
        label={copy.connect.ssh.key}
        value={ssh.keyPath}
        onChange={(v) => setSsh({ ...ssh, keyPath: v })}
        trailing={
          <button
            type="button"
            className={s['browse']}
            title={copy.connect.ssh.browse}
            onClick={() => void browseKey()}
          >
            {copy.connect.ssh.browse}
          </button>
        }
      />
      {envRow}
      <div className={s['body']}>{copy.connect.ssh.body}</div>
      {statusLine}
    </Modal>
  );
}

function TextField({
  label,
  hint,
  value,
  onChange,
  masked,
  trailing,
  inputRef,
}: {
  inputRef?: RefObject<HTMLInputElement | null>;
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  masked?: boolean;
  trailing?: ReactNode;
}) {
  const inputId = useId();
  return (
    <Field label={label} htmlFor={inputId} {...(hint !== undefined ? { hint } : {})}>
      <Input
        ref={inputRef}
        id={inputId}
        mono
        masked={masked === true}
        value={value}
        autoComplete="off"
        spellCheck={false}
        trailing={trailing}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
    </Field>
  );
}

function TokenField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const inputId = useId();
  return (
    <Field label={copy.connect.key.secret} htmlFor={inputId}>
      <Input
        id={inputId}
        masked
        value={value}
        autoComplete="off"
        onChange={(e) => onChange(e.currentTarget.value)}
      />
    </Field>
  );
}

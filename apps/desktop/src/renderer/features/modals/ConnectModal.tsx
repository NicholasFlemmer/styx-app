import {
  copy,
  fill,
  idFrom,
  platformCopy,
  type EventPayload,
  type ProjectId,
  type Provider,
  type TargetId,
} from '@styx/core';
import { Button, ChipGroup, Field, Input, Label, Modal } from '@styx/ui';
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { onEvent } from '../../state/bridge';
import { command } from '../../state/commands';
import { useUi } from '../../state/hooks';
import s from './ConnectModal.module.css';
import {
  CONNECT_ENVS,
  PROVIDERS,
  keyFormValid,
  methodLabel,
  methodOf,
  sshFormValid,
  sshTargetName,
  type ConnectStep,
  type KeyForm,
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
  browserUrl: string | null;
  phase: EventPayload<'connect.progress'>['phase'];
  message: string | null;
}

type ConnectEnv = (typeof CONNECT_ENVS)[number];

/**
 * Connect target (spec §4.10, modal 560): provider grid → per-method step (OAuth / IAM key / SSH). Secrets go
 * straight into `target.connect.*` inputs; nothing is echoed back. Token providers (`browserUrl === null`) get a
 * masked token field instead of the browser wait.
 */
export function ConnectModal({
  id,
  projectId: projectIdProp,
  provider: providerProp,
  targetId,
}: ConnectModalProps) {
  const popOverlay = useUi((u) => u.popOverlay);
  const platform = useUi((u) => u.platform);
  const activeProject = useUi((u) => u.projectId);
  const words = platformCopy(platform);

  const projectId: ProjectId | null = projectIdProp ?? activeProject;
  const initialProvider = providerProp ?? null;

  const [provider, setProvider] = useState<Provider>(initialProvider ?? 'vercel');
  const [step, setStep] = useState<ConnectStep>(
    initialProvider === null ? 'pick' : methodOf(initialProvider),
  );
  const [env, setEnv] = useState<ConnectEnv>('prod');
  const [flow, setFlow] = useState<OAuthFlow | null>(null);
  const [token, setToken] = useState('');
  const [key, setKey] = useState<KeyForm>({ name: '', accessKey: '', secret: '' });
  const [ssh, setSsh] = useState<SshForm>({ host: '', user: '', keyPath: '' });
  const [savedTargetId, setSavedTargetId] = useState<TargetId | null>(targetId ?? null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const firstTile = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLDivElement>(null);
  const firstInput = useRef<HTMLInputElement>(null);

  const close = () => popOverlay(id);
  const back = () => {
    setStep('pick');
    setFlow(null);
    setStatus(null);
  };
  const pick = (p: Provider) => {
    setProvider(p);
    setStep(methodOf(p));
    setFlow(null);
    setStatus(null);
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

  const startOauth = async () => {
    if (projectId === null || busy) return;
    setBusy(true);
    setStatus(null);
    const r = await command('target.connect.start', { projectId, provider, env });
    setBusy(false);
    if (!r.ok) return;
    setFlow({
      flowId: r.value.flowId,
      browserUrl: r.value.browserUrl,
      phase: 'waiting-browser',
      message: null,
    });
  };

  const saveToken = async () => {
    if (flow === null || token === '' || busy) return;
    setBusy(true);
    const r = await command('target.connect.saveToken', { targetId: idFrom<'TargetId'>(flow.flowId), token });
    setBusy(false);
    if (r.ok) close();
  };

  /** Saves once, then reuses the target id for later tests / the final save. */
  const ensureSaved = async (): Promise<TargetId | null> => {
    if (savedTargetId !== null) return savedTargetId;
    if (projectId === null) return null;
    let r;
    if (step === 'key') {
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
    } else {
      if (!sshFormValid(ssh)) return null;
      r = await command('target.connect.saveSsh', {
        projectId,
        name: sshTargetName(ssh),
        env,
        host: ssh.host.trim(),
        user: ssh.user.trim(),
        keyPath: ssh.keyPath.trim(),
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

  const title = fill(copy.connect.title, {
    step: step === 'pick' ? copy.connect.stepPick : methodLabel(provider),
  });
  const providerName = copy.providers[provider];
  const canSaveKey = keyFormValid(key) && projectId !== null && !busy;
  const canSaveSsh = sshFormValid(ssh) && projectId !== null && !busy;
  const tokenMode = flow !== null && flow.browserUrl === null;
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
        onChange={(v) => setEnv(v as ConnectEnv)}
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

  if (step === 'oauth') {
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
            {tokenMode ? (
              <Button
                size="footer"
                variant="primary"
                disabled={token === '' || busy}
                onClick={() => void saveToken()}
              >
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
            )}
          </>
        }
      >
        <div ref={heading} tabIndex={-1} className={s['providerName']}>
          {providerName}
        </div>
        <div className={s['body']}>{fill(copy.connect.oauth.body, { keychainName: words.keychainName })}</div>
        {envRow}
        {tokenMode ? (
          <TokenField value={token} onChange={setToken} />
        ) : (
          <div className={s['waiting']} aria-live="polite">
            <span>{copy.connect.oauth.waiting}</span>
            <span className={s['cursor']} aria-hidden="true" />
          </div>
        )}
        {statusLine}
      </Modal>
    );
  }

  if (step === 'key') {
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
            <Button size="footer" variant="secondary" disabled={!canSaveKey} onClick={() => void test()}>
              {copy.connect.key.test}
            </Button>
            <Button size="footer" variant="primary" disabled={!canSaveKey} onClick={() => void save()}>
              {saveLabel}
            </Button>
          </>
        }
      >
        <div className={s['providerName']}>{providerName}</div>
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
        {envRow}
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
      <TextField
        label={copy.connect.ssh.key}
        value={ssh.keyPath}
        onChange={(v) => setSsh({ ...ssh, keyPath: v })}
        trailing={
          // TODO(main): no file-picker command in the contract yet (`dialog.pickFile`); Browse stays disabled.
          <button type="button" className={s['browse']} disabled title={copy.connect.ssh.browse}>
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
  value,
  onChange,
  masked,
  trailing,
  inputRef,
}: {
  inputRef?: RefObject<HTMLInputElement | null>;
  label: string;
  value: string;
  onChange: (v: string) => void;
  masked?: boolean;
  trailing?: ReactNode;
}) {
  const inputId = useId();
  return (
    <Field label={label} htmlFor={inputId}>
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


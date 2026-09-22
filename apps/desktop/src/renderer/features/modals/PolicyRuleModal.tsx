import {
  copy,
  fill,
  platformCopy,
  rows,
  type Duration,
  type Env,
  type PolicyId,
  type PolicyRule,
  type Provider,
  type ReadModel,
  type Scope,
} from '@styx/core';
import { Button, Checkbox, ChipGroup, Field, Input, Modal } from '@styx/ui';
import { useCallback, useId, useMemo, useState } from 'react';
import { command } from '../../state/commands';
import { useCopyPlatform, useModel, useUi } from '../../state/hooks';
import s from './PolicyRuleModal.module.css';

export interface PolicyRuleModalProps {
  id: string;
  policyId?: PolicyId;
}

const PROVIDERS: readonly Provider[] = ['vercel', 'aws', 'gcp', 'supabase', 'github', 'ssh'];
const ENVS: readonly Env[] = ['prod', 'staging', 'preview', 'scm'];
const SCOPES: readonly Scope[] = ['read', 'write', 'deploy', 'delete'];
const DURATIONS: readonly Duration[] = ['once', '1h', 'session', 'always'];

type Kind = 'auto-approve' | 'ask';

const selectModel = (m: ReadModel) => m;

/** The rule text drafted from the choices, in the words the list and the audit log use. */
export const draftRuleText = (
  kind: Kind,
  providers: readonly Provider[],
  envs: readonly Env[],
  scopes: readonly Scope[],
  duration: Duration,
  requireMfa: boolean,
  mfa: string,
): string => {
  const d = copy.policies.editor.draft;
  const targets = providers.length === 0 ? d.anyTarget : providers.map((p) => copy.providers[p]).join(', ');
  const envText =
    envs.length === 0
      ? ''
      : fill(d.envSuffix, { envs: envs.map((e) => copy.policies.editor.envNames[e]).join(', ') });
  const scopeText = scopes.map((sc) => copy.grantSheet.scopes[sc].toLowerCase()).join(' + ');
  if (kind === 'auto-approve')
    return fill(d.auto, {
      scopes: scopeText,
      targets,
      envs: envText,
      duration: copy.grantSheet.durations[duration],
    });
  return fill(requireMfa ? d.askMfa : d.ask, { scopes: scopeText, targets, envs: envText, mfa });
};

/**
 * Approvals › Policies › + Rule (owner addition, discrepancy #109: the button was a no-op). One modal for an
 * auto-approve or ask rule: which targets and environments it matches, which scopes, how long an auto grant
 * lasts or whether an ask needs MFA, and the text the rule shows as. Built-in rules are not edited here.
 */
export function PolicyRuleModal({ id, policyId }: PolicyRuleModalProps) {
  const popOverlay = useUi((u) => u.popOverlay);
  const platform = useCopyPlatform();
  const mfa = platformCopy(platform).mfa;
  const model = useModel(selectModel);
  const existing = policyId === undefined ? null : (model.policies.byId[policyId] ?? null);
  const initial =
    existing?.rule.kind === 'auto-approve' || existing?.rule.kind === 'ask' ? existing.rule : null;

  const [kind, setKind] = useState<Kind>(initial?.kind ?? 'auto-approve');
  const [providers, setProviders] = useState<Provider[]>(initial?.match.provider ?? []);
  const [envs, setEnvs] = useState<Env[]>(initial?.match.env ?? []);
  const [scopes, setScopes] = useState<Scope[]>(initial?.scopes ?? ['read']);
  const [duration, setDuration] = useState<Duration>(
    initial?.kind === 'auto-approve' ? initial.duration : '1h',
  );
  const [requireMfa, setRequireMfa] = useState(initial?.kind === 'ask' ? initial.requireMfa : false);
  const drafted = useMemo(
    () => draftRuleText(kind, providers, envs, scopes, duration, requireMfa, mfa),
    [kind, providers, envs, scopes, duration, requireMfa, mfa],
  );
  // The text follows the choices until the person edits it; then it is theirs.
  const [ownText, setOwnText] = useState<string | null>(existing?.ruleText ?? null);
  const text = ownText ?? drafted;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textId = useId();
  const close = () => popOverlay(id);
  const ready = scopes.length > 0 && text.trim() !== '';

  const toggle = <T,>(list: readonly T[], v: T, on: boolean): T[] =>
    on ? (list.includes(v) ? [...list] : [...list, v]) : list.filter((x) => x !== v);

  const save = useCallback(async () => {
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    const match = {
      ...(providers.length > 0 ? { provider: providers } : {}),
      ...(envs.length > 0 ? { env: envs } : {}),
    };
    const rule: PolicyRule =
      kind === 'auto-approve' ? { kind, match, scopes, duration } : { kind, match, scopes, requireMfa };
    const r = await command('policy.upsert', {
      policyId: policyId ?? null,
      rule,
      ruleText: text.trim(),
      enabled: existing?.enabled ?? true,
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.error.message);
      return;
    }
    popOverlay(id);
  }, [
    busy,
    ready,
    providers,
    envs,
    kind,
    scopes,
    duration,
    requireMfa,
    policyId,
    text,
    existing,
    popOverlay,
    id,
  ]);

  const targetsInUse = useMemo(() => new Set(rows(model.targets).map((t) => t.provider)), [model.targets]);

  return (
    <Modal
      width={560}
      title={existing === null ? copy.policies.editor.title : copy.policies.editor.editTitle}
      onClose={close}
      bodyPad="20px 16px"
      footer={
        <>
          <Button size="footer" variant="ghost" onClick={close}>
            {copy.general.cancel}
          </Button>
          <Button
            size="footer"
            variant="primary"
            disabled={!ready || busy}
            onClick={() => void save()}
            data-policy-rule-save="true"
          >
            {existing === null ? copy.policies.editor.save : copy.policies.editor.saveEdit}
          </Button>
        </>
      }
    >
      <form
        className={s['root']}
        data-policy-rule="true"
        data-policy-rule-kind={kind}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className={s['lead']}>{copy.policies.editor.lead}</p>
        <Field label={copy.policies.editor.kind}>
          <ChipGroup
            layout="inline"
            size="env"
            aria-label={copy.policies.editor.kind}
            options={[
              { value: 'auto-approve', label: copy.policies.editor.kinds['auto-approve'] },
              { value: 'ask', label: copy.policies.editor.kinds.ask },
            ]}
            value={kind}
            onChange={(v) => setKind(v === 'ask' ? 'ask' : 'auto-approve')}
            data-policy-rule-kinds="true"
          />
        </Field>
        <Field
          label={copy.policies.editor.providers}
          hint={providers.length === 0 ? copy.policies.editor.anyProvider : undefined}
        >
          <div className={s['checks']} role="group" aria-label={copy.policies.editor.providers}>
            {PROVIDERS.map((p) => (
              <Checkbox
                key={p}
                label={copy.providers[p]}
                checked={providers.includes(p)}
                onChange={(on) => setProviders((prev) => toggle(prev, p, on))}
                data-policy-rule-provider={p}
                data-in-use={targetsInUse.has(p) ? 'true' : undefined}
              />
            ))}
          </div>
        </Field>
        <Field
          label={copy.policies.editor.envs}
          hint={envs.length === 0 ? copy.policies.editor.anyEnv : undefined}
        >
          <div className={s['checks']} role="group" aria-label={copy.policies.editor.envs}>
            {ENVS.map((e) => (
              <Checkbox
                key={e}
                label={copy.policies.editor.envNames[e]}
                checked={envs.includes(e)}
                onChange={(on) => setEnvs((prev) => toggle(prev, e, on))}
                data-policy-rule-env={e}
              />
            ))}
          </div>
        </Field>
        <Field
          label={copy.policies.editor.scopes}
          hint={scopes.length === 0 ? copy.policies.editor.needScope : undefined}
          on={scopes.length === 0}
        >
          <div className={s['checks']} role="group" aria-label={copy.policies.editor.scopes}>
            {SCOPES.map((sc) => (
              <Checkbox
                key={sc}
                label={copy.grantSheet.scopes[sc]}
                checked={scopes.includes(sc)}
                onChange={(on) => setScopes((prev) => toggle(prev, sc, on))}
                data-policy-rule-scope={sc}
              />
            ))}
          </div>
        </Field>
        {kind === 'auto-approve' ? (
          <Field label={copy.policies.editor.duration}>
            <ChipGroup
              layout="inline"
              size="duration"
              aria-label={copy.policies.editor.duration}
              options={DURATIONS.map((d) => ({ value: d, label: copy.grantSheet.durations[d] }))}
              value={duration}
              onChange={(v) => setDuration(DURATIONS.find((d) => d === v) ?? '1h')}
              data-policy-rule-durations="true"
            />
          </Field>
        ) : (
          <Checkbox
            label={fill(copy.policies.editor.requireMfa, { mfa })}
            checked={requireMfa}
            onChange={setRequireMfa}
            data-policy-rule-mfa="true"
          />
        )}
        <Field label={copy.policies.editor.text} htmlFor={textId} hint={copy.policies.editor.textHint}>
          <Input
            id={textId}
            value={text}
            onChange={(e) => setOwnText(e.target.value)}
            data-policy-rule-text="true"
          />
        </Field>
        {error !== null ? (
          <p className={s['error']} role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

import {
  DEPLOYABLE_PROVIDERS,
  copy,
  deployCommandOf,
  fill,
  projectNameOf,
  rows,
  type ProjectId,
  type ReadModel,
  type Target,
  type TargetId,
} from '@styx/core';
import { Button, Field, Input, Modal, Tag } from '@styx/ui';
import { useCallback, useId, useState } from 'react';
import { command } from '../../state/commands';
import { useModel, useUi } from '../../state/hooks';
import s from './DeploySetupModal.module.css';

export interface DeploySetupModalProps {
  id: string;
  projectId: ProjectId;
}

const selectModel = (m: ReadModel) => m;

/**
 * Deploy commands per target (owner request: only Vercel had a deploy verb, so a project on GCP, AWS or SSH could
 * never deploy from Styx). Each target without a built-in verb takes the command the user would run themselves;
 * Styx runs it through their login shell under a `deploy`-scoped grant, with the grant's credential env.
 */
export function DeploySetupModal({ id, projectId }: DeploySetupModalProps) {
  const popOverlay = useUi((u) => u.popOverlay);
  const model = useModel(selectModel);
  const project = projectNameOf(model, projectId);
  const targets = rows(model.targets).filter((t) => t.projectId === projectId);
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(targets.map((t) => [t.id, deployCommandOf(t) ?? ''])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const baseId = useId();

  const close = () => popOverlay(id);
  const changed = (t: Target) => (draft[t.id] ?? '').trim() !== (deployCommandOf(t) ?? '');
  const dirty = targets.some(changed);

  const save = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    for (const t of targets) {
      if (!changed(t)) continue;
      const text = (draft[t.id] ?? '').trim();
      const r = await command('target.setDeployCommand', {
        targetId: t.id as TargetId,
        command: text === '' ? null : text,
      });
      if (!r.ok) {
        setError(r.error.message);
        setBusy(false);
        return;
      }
    }
    setBusy(false);
    close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, draft, targets]);

  return (
    <Modal
      width={560}
      title={fill(copy.deploy.setupTitle, { project })}
      onClose={close}
      bodyPad="20px 16px"
      footer={
        <>
          <Button size="footer" variant="ghost" onClick={close}>
            {copy.general.cancel}
          </Button>
          <Button size="footer" variant="primary" disabled={!dirty || busy} onClick={() => void save()}>
            {copy.deploy.save}
          </Button>
        </>
      }
    >
      <div className={s['root']} data-deploy-setup="true">
        <p className={s['lead']}>{copy.deploy.setupLead}</p>
        {targets.length === 0 ? <p className={s['lead']}>{copy.deploy.noTargets}</p> : null}
        {targets.map((t) => {
          const builtIn = DEPLOYABLE_PROVIDERS.includes(t.provider);
          const fieldId = `${baseId}-${t.id}`;
          return (
            <div key={t.id} className={s['target']} data-deploy-target={t.id}>
              <div className={s['head']}>
                <span className={s['name']}>{t.name}</span>
                <Tag tone={t.env === 'prod' ? 'accent' : 'neutral'}>{t.env}</Tag>
                <span className={s['provider']}>{copy.providers[t.provider]}</span>
              </div>
              {builtIn ? (
                <span className={s['builtIn']}>
                  {fill(copy.deploy.builtIn, {
                    command: t.env === 'prod' ? copy.deploy.placeholders.vercel : 'vercel deploy',
                  })}
                </span>
              ) : (
                <Field label={copy.deploy.commandLabel} htmlFor={fieldId}>
                  <Input
                    id={fieldId}
                    mono
                    value={draft[t.id] ?? ''}
                    placeholder={copy.deploy.placeholders[t.provider]}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => setDraft({ ...draft, [t.id]: e.currentTarget.value })}
                  />
                </Field>
              )}
            </div>
          );
        })}
        {error !== null ? (
          <p className={s['error']} role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

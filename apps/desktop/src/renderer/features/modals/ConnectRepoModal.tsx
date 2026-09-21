import { copy, fill, projectNameOf, rows, type ProjectId, type ReadModel, type WorktreeId } from '@styx/core';
import { Button, Checkbox, ChipGroup, Field, Input, Modal } from '@styx/ui';
import { useCallback, useId, useState } from 'react';
import { command } from '../../state/commands';
import { useModel, useUi } from '../../state/hooks';
import s from './ConnectRepoModal.module.css';

export interface ConnectRepoModalProps {
  id: string;
  projectId: ProjectId;
  /** Opened from Publish: once the remote is there, Publish comes back for the same worktree. */
  returnTo?: { modal: 'publish'; worktreeId: WorktreeId };
}

type Kind = 'create' | 'existing';

const selectModel = (m: ReadModel) => m;

/** GitHub's own rule for a repository name, and the default: the project's name in that shape. */
export const repoNameOf = (project: string): string =>
  project
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);

/**
 * Connect a project to a GitHub repo (owner report: Publish said "add a remote under Repo" and Repo had no way).
 * Two roads: a new private repo through the connected GitHub target — created, set as `origin`, the current
 * branch pushed — or an existing repo's URL as `origin`. The second needs no GitHub connection at all.
 */
export function ConnectRepoModal({ id, projectId, returnTo }: ConnectRepoModalProps) {
  const popOverlay = useUi((u) => u.popOverlay);
  const pushOverlay = useUi((u) => u.pushOverlay);
  const model = useModel(selectModel);
  const project = projectNameOf(model, projectId);
  const hasGithub = rows(model.targets).some((t) => t.provider === 'github' && t.credentialRef !== null);
  // Reconnect: the remote that is there is shown and replaced, never edited in place (a wrong or dead one).
  const current = rows(model.repos).find((r) => r.projectId === projectId)?.remotes[0]?.url ?? null;
  const [kind, setKind] = useState<Kind>(hasGithub ? 'create' : 'existing');
  const [name, setName] = useState(() => repoNameOf(project));
  const [isPrivate, setPrivate] = useState(true);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const urlId = useId();

  const close = () => popOverlay(id);
  const ready = kind === 'create' ? hasGithub && name.trim() !== '' : url.trim() !== '';

  const connect = useCallback(async () => {
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    const r = await command('project.connectRemote', {
      projectId,
      remote:
        kind === 'create'
          ? { kind: 'create', name: name.trim(), isPrivate }
          : { kind: 'existing', url: url.trim() },
      replace: current !== null,
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.error.message);
      return;
    }
    popOverlay(id);
    if (returnTo !== undefined) pushOverlay({ kind: 'modal', ...returnTo });
  }, [busy, ready, projectId, kind, name, isPrivate, url, current, popOverlay, pushOverlay, id, returnTo]);

  return (
    <Modal
      width={560}
      title={fill(copy.connectRepo.title, { project })}
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
            onClick={() => void connect()}
            data-connect-repo-cta="true"
          >
            {busy
              ? copy.connectRepo.connecting
              : current !== null
                ? copy.connectRepo.reconnectCta
                : copy.connectRepo.cta}
          </Button>
        </>
      }
    >
      <form
        className={s['root']}
        data-connect-repo="true"
        data-connect-repo-kind={kind}
        onSubmit={(e) => {
          e.preventDefault();
          void connect();
        }}
      >
        <p className={s['lead']}>{copy.connectRepo.lead}</p>
        {current !== null ? (
          <p className={s['hint']} data-connect-repo-current="true">
            {fill(copy.connectRepo.current, { url: current })}
          </p>
        ) : null}
        <ChipGroup
          layout="inline"
          size="env"
          aria-label={copy.connectRepo.kindLabel}
          options={[
            { value: 'create', label: copy.connectRepo.kinds.create },
            { value: 'existing', label: copy.connectRepo.kinds.existing },
          ]}
          value={kind}
          onChange={(v) => setKind(v === 'existing' ? 'existing' : 'create')}
          data-connect-repo-kinds="true"
        />
        {kind === 'create' ? (
          <>
            {!hasGithub ? (
              <p className={s['hint']} data-connect-repo-no-github="true">
                {copy.connectRepo.noGithub}
              </p>
            ) : null}
            <Field label={copy.connectRepo.name} htmlFor={nameId}>
              <Input
                id={nameId}
                mono
                value={name}
                spellCheck={false}
                autoComplete="off"
                disabled={!hasGithub}
                onChange={(e) => setName(e.currentTarget.value)}
                data-connect-repo-name="true"
              />
            </Field>
            <Checkbox
              checked={isPrivate}
              disabled={!hasGithub}
              onChange={setPrivate}
              label={copy.connectRepo.private}
              data-connect-repo-private="true"
            />
          </>
        ) : (
          <Field label={copy.connectRepo.url} htmlFor={urlId}>
            <Input
              id={urlId}
              mono
              value={url}
              placeholder={copy.connectRepo.urlPlaceholder}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setUrl(e.currentTarget.value)}
              data-connect-repo-url="true"
            />
          </Field>
        )}
        {error !== null ? (
          <p className={s['error']} role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

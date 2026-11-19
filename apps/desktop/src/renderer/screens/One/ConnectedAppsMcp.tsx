import { copy, rows, type ConnectedApp, type ProjectId, type ReadModel } from '@styx/core';
import { Button } from '@styx/ui';
import { useState, type FormEvent } from 'react';
import { command } from '../../state/commands';
import { useModel, useUi } from '../../state/hooks';
import s from './One.module.css';

const projectsOf = (m: ReadModel) => rows(m.projects).filter((p) => p.removedAt == null);

/** Which projects' tasks may use the app: none until turned on (an app's data is the person's, not every task's). */
export function UsedIn({ app }: { app: ConnectedApp }) {
  const projects = useModel(projectsOf);
  const a = copy.one.apps;
  const toggle = (id: ProjectId) => {
    const next = app.projects.includes(id) ? app.projects.filter((p) => p !== id) : [...app.projects, id];
    void command('connectedApps.setProjects', { appId: app.id, projectIds: next as ProjectId[] });
  };
  return (
    <div className={s['filters']} role="group" aria-label={`${a.usedIn}: ${app.name}`}>
      <span className={s['needWhy']}>{app.projects.length === 0 ? a.noProjectsYet : a.usedIn}</span>
      {projects.map((p) => {
        const on = app.projects.includes(p.id);
        return (
          <Button key={p.id} size="compact" inv={on} aria-pressed={on} onClick={() => toggle(p.id)}>
            {p.name}
          </Button>
        );
      })}
    </div>
  );
}

/** Meta Ads, built in: the ad account and a Marketing API token, checked with Meta before anything is kept. */
export function MetaAds() {
  const m = copy.one.apps.meta;
  const projectId = useUi((u) => u.projectId);
  const [account, setAccount] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = account.trim().length >= 5 && token.trim().length >= 20 && !busy;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    const r = await command('connectedApps.addMetaAds', {
      token: token.trim(),
      adAccount: account.trim(),
      projectId,
    });
    setBusy(false);
    // The token leaves this form either way: it is in the keychain now, or it was refused.
    setToken('');
    if (!r.ok) setError(r.error.message);
    else setAccount('');
  };
  return (
    <form className={s['metaBox']} onSubmit={(e) => void submit(e)} aria-label={m.name}>
      <span className={s['appName']}>
        {m.name}
        <span className={s['appSub']}>{m.lead}</span>
      </span>
      <div className={`${s['askRow']} ${s['formRow']}`}>
        <label className={s['field']}>
          <span>{m.account}</span>
          <input
            className={s['askSelect']}
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            placeholder="act_"
            maxLength={40}
          />
        </label>
        <label className={`${s['field']} ${s['grow']}`}>
          <span>{m.token}</span>
          <input
            className={s['askSelect']}
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            maxLength={1000}
          />
        </label>
        <Button type="submit" variant="accent" size="regular" disabled={!ready}>
          {m.connect}
        </Button>
      </div>
      <span className={s['needWhy']}>{m.tokenHint}</span>
      {error === null ? null : (
        <span className={s['askError']} role="alert">
          {error}
        </span>
      )}
    </form>
  );
}

export function AddApp() {
  const a = copy.one.apps;
  // Turned on for the project the person is in; more under each app.
  const projectId = useUi((u) => u.projectId);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || name.trim() === '' || url.trim() === '') return;
    setBusy(true);
    setError(null);
    const r = await command('connectedApps.add', { name: name.trim(), url: url.trim(), projectId });
    setBusy(false);
    if (!r.ok) {
      setError(r.error.message);
      return;
    }
    setName('');
    setUrl('');
  };
  return (
    <form
      className={`${s['askRow']} ${s['formRow']}`}
      onSubmit={(e) => void submit(e)}
      aria-label={a.addByUrl}
    >
      <label className={s['field']}>
        <span>{a.nameLabel}</span>
        <input
          className={s['askSelect']}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
        />
      </label>
      <label className={`${s['field']} ${s['grow']}`}>
        <span>{a.urlLabel}</span>
        <input
          className={s['askSelect']}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          inputMode="url"
          placeholder="https://"
          maxLength={500}
        />
      </label>
      <Button type="submit" size="regular" disabled={busy || name.trim() === '' || url.trim() === ''}>
        {a.add}
      </Button>
      {error === null ? null : (
        <span className={s['askError']} role="alert">
          {error}
        </span>
      )}
    </form>
  );
}

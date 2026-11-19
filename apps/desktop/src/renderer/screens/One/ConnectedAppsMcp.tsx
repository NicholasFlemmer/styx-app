import { copy, fill, rows, type ConnectedApp, type ProjectId, type ReadModel } from '@styx/core';
import { Button } from '@styx/ui';
import { useState, type FormEvent } from 'react';
import { command } from '../../state/commands';
import { useModel, useUi } from '../../state/hooks';
import s from './One.module.css';

const appsOf = (m: ReadModel) => m.connectedApps;
const projectsOf = (m: ReadModel) => rows(m.projects).filter((p) => p.removedAt == null);

/**
 * Apps with their own connection for AI (ADR-0033 tier 2): add one by its address, sign in on its page, and see
 * what it can do. Styx keeps the sign-in in the keychain; an agent's change in the app waits for your OK.
 */
export function ConnectedAppsMcp() {
  const apps = useModel(appsOf);
  const a = copy.one.apps;
  return (
    <section className={s['box']} aria-labelledby="one-mcp-title" data-one-mcp="true">
      <h2 className={s['h3']}>{a.builtInTitle}</h2>
      <MetaAds />
      <p className={s['lead']}>{a.google}</p>
      <h2 className={s['h3']} id="one-mcp-title">
        {a.mcpTitle}
      </h2>
      <p className={s['lead']}>{a.mcpLead}</p>
      <AddApp />
      {apps.length === 0 ? (
        <p className={s['empty']}>{a.mcpEmpty}</p>
      ) : (
        <ul className={s['lines']} aria-label={a.mcpTitle}>
          {apps.map((app) => (
            <AppRow key={app.id} app={app} />
          ))}
        </ul>
      )}
    </section>
  );
}

function AppRow({ app }: { app: ConnectedApp }) {
  const a = copy.one.apps;
  const reads = app.tools.filter((t) => t.readOnly).length;
  const busy = app.status === 'signing-in';
  const builtIn = app.kind !== 'mcp';
  return (
    <li className={s['appItem']} data-one-mcp-app={app.id}>
      <div className={s['appRow']}>
        <span className={s['appName']}>
          {app.name}
          <span className={s['appSub']}>
            {app.status === 'connected'
              ? `${fill(a.tools, { n: app.tools.length })} · ${reads} ${a.readOnly} · ${a.asks}`
              : app.status === 'error' && app.error !== null
                ? `${a.status.error}: ${app.error}`
                : a.status[app.status]}
          </span>
        </span>
        {app.status === 'connected' || busy || builtIn ? (
          <span className={s['needWhy']} role="status">
            {builtIn && app.status !== 'connected' ? a.meta.replace : a.status[app.status]}
          </span>
        ) : (
          <Button
            variant="accent"
            size="regular"
            onClick={() => void command('connectedApps.signIn', { appId: app.id })}
          >
            {a.signIn}
          </Button>
        )}
        <Button
          size="regular"
          aria-label={`${a.remove} ${app.name}`}
          onClick={() => void command('connectedApps.remove', { appId: app.id })}
        >
          {a.remove}
        </Button>
      </div>
      <UsedIn app={app} />
    </li>
  );
}

/** Which projects' tasks may use the app: none until turned on (an app's data is the person's, not every task's). */
function UsedIn({ app }: { app: ConnectedApp }) {
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
function MetaAds() {
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

function AddApp() {
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

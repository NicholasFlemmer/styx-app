import { copy, fill, type HubContextEntry, type ReadModel } from '@styx/core';
import { Button } from '@styx/ui';
import { useCallback, useEffect, useState } from 'react';
import { command } from '../../state/commands';
import { useModel } from '../../state/hooks';
import s from './Team.module.css';

const selectHub = (m: ReadModel) => m.hub;
const t = copy.hub.lean;

const when = (at: number): string =>
  new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** Paragraphs as the person wrote them; React escapes the text. */
function Body({ text }: { text: string }) {
  return (
    <div className={s['doc']}>
      {text
        .split(/\n{2,}/)
        .filter((p) => p.trim() !== '')
        .map((p, i) => (
          <p key={i}>{p}</p>
        ))}
    </div>
  );
}

/** Add or edit one entry: a title, decision or note, the words. */
function EntryForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: { title: string; body: string; kind: 'decision' | 'doc' } | null;
  onSave: (v: { title: string; body: string; kind: 'decision' | 'doc' }) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [kind, setKind] = useState<'decision' | 'doc'>(initial?.kind ?? 'doc');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className={s['form']}
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void onSave({ title: title.trim(), body, kind }).then((err) => {
          setBusy(false);
          setError(err);
        });
      }}
      data-team-form={initial === null ? 'add' : 'edit'}
    >
      <label className={s['label']} htmlFor="ctx-title">
        {t.title}
      </label>
      <input
        id="ctx-title"
        className={s['input']}
        value={title}
        maxLength={200}
        required
        onChange={(e) => setTitle(e.currentTarget.value)}
      />
      {initial === null ? (
        <div className={s['seg']} role="group" aria-label={t.kindLabel}>
          {(['decision', 'doc'] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              data-inv={kind === k ? 'true' : undefined}
              onClick={() => setKind(k)}
            >
              {k === 'decision' ? t.decision : t.note}
            </button>
          ))}
        </div>
      ) : null}
      <label className={s['label']} htmlFor="ctx-body">
        {t.body}
      </label>
      <textarea
        id="ctx-body"
        className={`${s['input']} ${s['area']}`}
        value={body}
        maxLength={20000}
        onChange={(e) => setBody(e.currentTarget.value)}
      />
      {error !== null ? (
        <p className={s['error']} role="alert">
          {error}
        </p>
      ) : null}
      <div className={s['opts']}>
        <Button type="submit" variant="accent" disabled={busy || title.trim() === ''}>
          {initial === null ? t.add : t.save}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t.cancel}
        </Button>
      </div>
    </form>
  );
}

/**
 * Team context (the lean hub, mockup design/next/styx-next-share-links.html frame 3): what the business knows, in
 * one place. Anyone on the team adds to it, edits it or marks an entry out of date; every agent can use it, in any
 * project. Read through main's commands; nothing here is stored in the renderer beyond the view.
 */
export function Team() {
  const hub = useModel(selectHub);
  const signedIn = hub.connection.kind === 'signed-in';
  const team = hub.connection.kind === 'signed-in' ? (hub.connection.teams[0]?.name ?? '') : '';
  const [items, setItems] = useState<HubContextEntry[] | null>(null);
  const [q, setQ] = useState('');
  const [stale, setStale] = useState(false);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [mode, setMode] = useState<'read' | 'add' | 'edit'>('read');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (query: string, withStale: boolean) => {
    const r = await command('hub.teamContext', {
      ...(query.trim() === '' ? {} : { q: query.trim() }),
      ...(withStale ? { stale: true } : {}),
    });
    if (r.ok) {
      setItems(r.value.items);
      setError(null);
    } else setError(r.error.message);
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    const timer = setTimeout(() => {
      void command('hub.teamContext', {
        ...(q.trim() === '' ? {} : { q: q.trim() }),
        ...(stale ? { stale: true } : {}),
      }).then((r) => {
        if (!live) return;
        if (r.ok) setItems(r.value.items);
        else setError(r.error.message);
      });
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [signedIn, q, stale]);

  // Signing in: the browser page asks for this code, so it is the one thing this screen shows.
  if (hub.connection.kind === 'signing-in')
    return (
      <div className={s['screen']} data-screen-ready="true" data-team="signing-in">
        <div className={s['lone']}>
          <h1 className={s['h1']}>{t.context}</h1>
          <p className={s['muted']}>{copy.hub.codeLabel}</p>
          <span className={s['userCode']} data-hub-code="true">
            {hub.connection.userCode}
          </span>
          <div className={s['opts']}>
            <Button variant="accent" onClick={() => void command('hub.openVerification', {})}>
              {copy.hub.openBrowser}
            </Button>
            <Button variant="ghost" onClick={() => void command('hub.cancelSignIn', {})}>
              {copy.hub.cancel}
            </Button>
          </div>
        </div>
      </div>
    );

  if (!signedIn)
    return (
      <div className={s['screen']} data-screen-ready="true" data-team="signed-out">
        <div className={s['lone']}>
          <h1 className={s['h1']}>{t.context}</h1>
          <p className={s['muted']}>{copy.hub.teamScreen.signedOut}</p>
          {hub.connection.kind === 'signed-out' && hub.connection.error !== null ? (
            <p className={s['error']} role="alert">
              {hub.connection.error}
            </p>
          ) : null}
          <Button variant="accent" onClick={() => void command('hub.signIn', {})}>
            {copy.hub.signIn}
          </Button>
        </div>
      </div>
    );

  const list = items ?? [];
  const current = list.find((i) => i.id === currentId) ?? null;
  const refresh = () => void load(q, stale);

  return (
    <div className={s['screen']} data-screen-ready="true" data-team="signed-in">
      <aside className={s['inbox']} aria-label={t.context}>
        <div className={s['ih']}>
          <h1 className={s['h2']}>{t.context}</h1>
        </div>
        <p className={s['sub']}>
          {list.length === 1
            ? fill(t.contextLeadOne, { team })
            : fill(t.contextLead, { team, n: String(list.length) })}
        </p>
        <div className={s['find']}>
          <input
            className={s['input']}
            type="search"
            aria-label={t.find}
            placeholder={t.find}
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
          />
          <label className={s['check']}>
            <input type="checkbox" checked={stale} onChange={(e) => setStale(e.currentTarget.checked)} />{' '}
            {t.showStale}
          </label>
        </div>
        {items !== null && list.length === 0 ? (
          <p className={s['empty']}>{q.trim() === '' ? t.empty : t.nothingFound}</p>
        ) : null}
        <ul className={s['entries']}>
          {list.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                className={s['entryOpen']}
                data-inv={currentId === i.id && mode === 'read' ? 'true' : undefined}
                data-stale={i.stale ? 'true' : undefined}
                onClick={() => {
                  setCurrentId(i.id);
                  setMode('read');
                }}
                data-team-entry={i.id}
              >
                <b>{i.title}</b>
                <span className={s['who']}>
                  {fill(t.byLine, { kind: t.kinds[i.kind], by: i.by, when: when(i.updatedAt) })}
                  {i.stale ? ` · ${t.staleTag}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className={s['addRow']}>
          <Button
            variant="accent"
            onClick={() => {
              setMode('add');
              setCurrentId(null);
            }}
            data-team-add="true"
          >
            {t.addToContext}
          </Button>
        </div>
      </aside>
      <section className={s['thread']} aria-live="polite">
        {error !== null ? (
          <p className={s['error']} role="alert">
            {error}
          </p>
        ) : null}
        {mode === 'add' ? (
          <div className={s['scroll']}>
            <h2 className={s['h2']}>{t.addTitle}</h2>
            <p className={s['muted0']}>{fill(t.reachesEveryone, { team })}</p>
            <EntryForm
              initial={null}
              onCancel={() => setMode('read')}
              onSave={async (v) => {
                const r = await command('hub.addContext', v);
                if (!r.ok) return r.error.message;
                setCurrentId(r.value.id);
                setMode('read');
                await load(q, stale);
                return null;
              }}
            />
          </div>
        ) : current === null ? (
          <p className={s['muted']}>{t.pick}</p>
        ) : mode === 'edit' ? (
          <div className={s['scroll']}>
            <EntryForm
              initial={{
                title: current.title,
                body: current.body,
                kind: current.kind === 'decision' ? 'decision' : 'doc',
              }}
              onCancel={() => setMode('read')}
              onSave={async (v) => {
                const r = await command('hub.updateContext', {
                  id: current.id,
                  title: v.title,
                  body: v.body,
                });
                if (!r.ok) return r.error.message;
                setMode('read');
                await load(q, stale);
                return null;
              }}
            />
          </div>
        ) : (
          <>
            <div className={s['th']}>
              <h2 className={s['h2']}>{current.title}</h2>
              <span className={s['meta']}>
                {fill(t.byLine, {
                  kind: t.kinds[current.kind],
                  by: current.by,
                  when: when(current.updatedAt),
                })}
                {current.stale ? ` · ${t.staleTag}` : ''}
              </span>
              <div className={s['acts']}>
                <Button onClick={() => setMode('edit')}>{t.edit}</Button>
                <Button
                  onClick={() =>
                    void command('hub.updateContext', { id: current.id, stale: !current.stale }).then(refresh)
                  }
                >
                  {current.stale ? t.backInDate : t.outOfDate}
                </Button>
              </div>
            </div>
            <div className={s['scroll']}>
              <Body text={current.body} />
            </div>
          </>
        )}
      </section>
    </div>
  );
}

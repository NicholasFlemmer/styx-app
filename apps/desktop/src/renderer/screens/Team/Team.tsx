import { copy, fill, type HubInboxEntry, type HubThreadView, type ReadModel } from '@styx/core';
import { Button } from '@styx/ui';
import { useCallback, useEffect, useState } from 'react';
import { command } from '../../state/commands';
import { useModel } from '../../state/hooks';
import s from './Team.module.css';

const selectHub = (m: ReadModel) => m.hub;
const GROUPS = ['ask', 'mention', 'task', 'review'] as const;

const whoOf = (e: HubInboxEntry): string =>
  e.who.agent === null ? (e.who.name ?? '') : `${e.who.agent} for ${e.who.name ?? ''}`;

/** Text with `@mentions` marked (React escapes the rest). */
function Body({ text }: { text: string }) {
  const parts = text.split(/(@[\w./-]+)/g);
  return (
    <span className={s['body']}>
      {parts.map((p, i) =>
        /^@[\w./-]+$/.test(p) ? (
          <span key={i} className={s['mention']}>
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </span>
  );
}

/** An ask's answer controls: one button per option, or a text box for a written answer. */
function AnswerAsk({
  askId,
  options,
  onDone,
}: {
  askId: string;
  options: string[] | null;
  onDone: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (input: { choice?: string; text?: string }) => {
    setBusy(true);
    await command('hub.answer', { askId, ...input });
    setBusy(false);
    onDone();
  };
  if (options !== null)
    return (
      <div className={s['opts']}>
        {options.map((o, i) => (
          <Button
            key={o}
            variant={i === 0 ? 'accent' : 'secondary'}
            disabled={busy}
            onClick={() => void send({ choice: o })}
          >
            {o}
          </Button>
        ))}
      </div>
    );
  return (
    <form
      className={s['opts']}
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim() !== '') void send({ text: text.trim() });
      }}
    >
      <input
        className={s['input']}
        aria-label={copy.hub.teamScreen.answerLabel}
        placeholder={copy.hub.teamScreen.answer}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
      />
      <Button type="submit" disabled={busy || text.trim() === ''}>
        {copy.hub.teamScreen.send}
      </Button>
    </form>
  );
}

/**
 * Team (ADR-0032 round 1, mockup design/next/styx-next-hub-team.html): what waits on the person across their
 * spaces, answerable in place, and the thread each came from: where it stands, its tasks, its asks and the
 * conversation, with a reply box that posts as the person. Reads the hub through main's commands.
 */
export function Team() {
  const hub = useModel(selectHub);
  const [entries, setEntries] = useState<HubInboxEntry[] | null>(null);
  const [current, setCurrent] = useState<HubInboxEntry | null>(null);
  const [view, setView] = useState<HubThreadView | null>(null);
  const [reply, setReply] = useState('');
  const [error, setError] = useState<string | null>(null);
  const signedIn = hub.connection.kind === 'signed-in';
  const me =
    hub.connection.kind === 'signed-in' ? (hub.connection.account.name ?? hub.connection.account.email) : '';

  const load = useCallback(async () => {
    const r = await command('hub.inbox', {});
    if (r.ok) setEntries(r.value.entries);
    else setError(r.error.message);
  }, []);
  const open = useCallback(async (threadId: string | null) => {
    if (threadId === null) {
      setView(null);
      return;
    }
    const r = await command('hub.thread', { threadId });
    if (r.ok) setView(r.value);
    else setError(r.error.message);
  }, []);

  // Read again whenever the waiting count moves (main follows the hub), and on arrival.
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    void command('hub.inbox', {}).then((r) => {
      if (!live) return;
      if (r.ok) setEntries(r.value.entries);
      else setError(r.error.message);
    });
    return () => {
      live = false;
    };
  }, [signedIn, hub.waiting]);

  if (!signedIn)
    return (
      <div className={s['screen']} data-screen-ready="true" data-team="signed-out">
        <div className={s['lone']}>
          <h1 className={s['h1']}>{copy.hub.teamScreen.title}</h1>
          <p className={s['muted']}>{copy.hub.teamScreen.signedOut}</p>
          <Button variant="accent" onClick={() => void command('hub.signIn', {})}>
            {copy.hub.signIn}
          </Button>
        </div>
      </div>
    );

  const pick = (e: HubInboxEntry) => {
    setCurrent(e);
    setError(null);
    void open(e.threadId);
    if (!e.read) void command('hub.markRead', { ids: [e.id] });
  };
  const refreshBoth = () => {
    void load();
    if (view !== null) void open(view.thread.id);
  };
  const list = entries ?? [];

  return (
    <div className={s['screen']} data-screen-ready="true" data-team="signed-in">
      <aside className={s['inbox']} aria-label={copy.hub.teamScreen.waiting}>
        <div className={s['ih']}>
          <h1 className={s['h2']}>{copy.hub.teamScreen.waiting}</h1>
          <button
            type="button"
            className={s['link']}
            onClick={() => void command('hub.markRead', { ids: list.map((e) => e.id) }).then(() => load())}
          >
            {copy.hub.teamScreen.markAllRead}
          </button>
        </div>
        {GROUPS.map((g) => {
          const rows = list.filter((e) => e.kind === g);
          return (
            <section key={g} aria-label={copy.hub.teamScreen.groups[g]}>
              <div className={s['group']}>
                <span>{copy.hub.teamScreen.groups[g]}</span>
                <span>{rows.length}</span>
              </div>
              {rows.length === 0 ? (
                <p className={s['empty']}>{copy.hub.teamScreen.empty[g]}</p>
              ) : (
                rows.map((e) => (
                  <div
                    key={e.id}
                    className={s['entry']}
                    data-inv={current?.id === e.id ? 'true' : undefined}
                    data-team-entry={e.kind}
                  >
                    <button type="button" className={s['entryOpen']} onClick={() => pick(e)}>
                      <span className={s['who']}>
                        {e.read ? null : <span className={s['unread']} aria-label="unread" />}
                        <b>{whoOf(e)}</b> · {e.spaceName} · {e.title}
                      </span>
                      <Body text={e.snippet} />
                    </button>
                    {e.kind === 'ask' && e.ask !== null ? (
                      <AnswerAsk askId={e.ask.id} options={e.ask.options} onDone={refreshBoth} />
                    ) : null}
                  </div>
                ))
              )}
            </section>
          );
        })}
      </aside>
      <section className={s['thread']} aria-live="polite">
        {error !== null ? (
          <p className={s['error']} role="alert">
            {error}
          </p>
        ) : null}
        {view === null ? (
          <p className={s['muted']}>
            {current !== null && current.threadId === null
              ? copy.hub.teamScreen.noThread
              : copy.hub.teamScreen.pick}
          </p>
        ) : (
          <>
            <div className={s['th']}>
              <h2 className={s['h2']}>{view.thread.title}</h2>
              <span className={s['meta']}>
                {view.thread.spaceName} ·{' '}
                {view.thread.owner === null
                  ? copy.hub.teamScreen.noOwner
                  : fill(copy.hub.teamScreen.owner, { name: view.thread.owner })}{' '}
                · {view.thread.status} ·{' '}
                {fill(copy.hub.teamScreen.progress, {
                  done: String(view.tasks.filter((t) => t.done).length),
                  total: String(view.tasks.length),
                })}
              </span>
              <div className={s['acts']}>
                <Button onClick={() => void command('hub.openWeb', {})}>{copy.hub.teamScreen.openWeb}</Button>
                <Button
                  onClick={() =>
                    void command('hub.setThreadStatus', {
                      threadId: view.thread.id,
                      status: view.thread.status === 'open' ? 'done' : 'open',
                    }).then(refreshBoth)
                  }
                >
                  {view.thread.status === 'open' ? copy.hub.teamScreen.markDone : copy.hub.teamScreen.reopen}
                </Button>
              </div>
            </div>
            <div className={s['scroll']}>
              <div className={s['stand']}>
                <span className={s['label']}>{copy.hub.teamScreen.stands}</span>
                {view.thread.summary === '' ? copy.hub.teamScreen.nothingYet : view.thread.summary}
              </div>
              {view.tasks.length > 0 ? (
                <ul className={s['tasks']} aria-label={copy.hub.teamScreen.tasks}>
                  {view.tasks.map((t) => (
                    <li key={t.id}>
                      <input
                        type="checkbox"
                        checked={t.done}
                        aria-label={t.text}
                        onChange={(e) =>
                          void command('hub.setTask', { taskId: t.id, done: e.currentTarget.checked }).then(
                            refreshBoth,
                          )
                        }
                      />
                      <span className={t.done ? s['done'] : undefined}>{t.text}</span>
                      <span className={s['assignee']}>{t.assignee ?? ''}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <ol className={s['msgs']}>
                {view.messages.map((m) => (
                  <li key={m.id} className={s['msg']}>
                    <span className={s['who']}>
                      <b>{m.agent === null ? m.who : `${m.agent} for ${m.who}`}</b>
                      {m.branch === null ? null : <span className={s['mono']}>{m.branch}</span>}
                    </span>
                    <Body text={m.body} />
                  </li>
                ))}
              </ol>
              {view.asks.map((a) => (
                <div key={a.id} className={s['ask']} data-team-ask={a.open ? 'open' : 'answered'}>
                  <b>
                    {fill(copy.hub.teamScreen.asks, { name: a.asker })}: {a.question}
                  </b>
                  {a.open && a.canAnswer ? (
                    <AnswerAsk askId={a.id} options={a.options} onDone={refreshBoth} />
                  ) : a.answer !== null ? (
                    <span className={s['muted']}>
                      {fill(copy.hub.teamScreen.answered, { answer: a.answer })}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
            <form
              className={s['reply']}
              onSubmit={(e) => {
                e.preventDefault();
                const body = reply.trim();
                if (body === '') return;
                void command('hub.reply', { threadId: view.thread.id, body }).then((r) => {
                  if (r.ok) {
                    setReply('');
                    refreshBoth();
                  } else setError(r.error.message);
                });
              }}
            >
              <textarea
                className={s['input']}
                rows={2}
                aria-label={fill(copy.hub.teamScreen.replyLabel, { name: me })}
                placeholder={fill(copy.hub.teamScreen.replyLabel, { name: me })}
                value={reply}
                onChange={(e) => setReply(e.currentTarget.value)}
              />
              <Button type="submit" variant="accent" disabled={reply.trim() === ''}>
                {copy.hub.teamScreen.send}
              </Button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}

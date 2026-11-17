import { copy, fill, type HubConversationLink, type ReadModel, type SessionId } from '@styx/core';
import { Button } from '@styx/ui';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { command } from '../../state/commands';
import { useModel } from '../../state/hooks';
import s from './HubLaneControl.module.css';
import l from './Lean.module.css';

const t = copy.hub.lean;
const selectSignedIn = (m: ReadModel) => m.hub.connection.kind === 'signed-in';
type Expiry = '1d' | '7d' | '30d' | 'never';

const ago = (at: number): string => {
  const d = new Date(at);
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const opens = (n: number): string =>
  n === 0 ? t.opens.none : n === 1 ? t.opens.one : fill(t.opens.many, { n: String(n) });

/**
 * Share a conversation as a link (the lean hub, mockup styx-next-share-links.html frame 1): the lane header's Share
 * for the whole conversation, or an answer's Share for that answer. Copy link is the person's move; the rest has
 * defaults. Links already made are listed with Turn off.
 */
export function ShareConversation({
  sessionId,
  messageId,
  variant = 'header',
}: {
  sessionId: SessionId;
  messageId: string | null;
  variant?: 'header' | 'answer';
}) {
  const signedIn = useModel(selectSignedIn);
  const [open, setOpen] = useState(false);
  const [live, setLive] = useState(false);
  const [expiresIn, setExpiresIn] = useState<Expiry>('7d');
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [links, setLinks] = useState<HubConversationLink[]>([]);
  const [error, setError] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current !== null && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const loadLinks = () =>
    void command('hub.conversationLinks', { sessionId }).then((r) => {
      if (r.ok) setLinks(r.value.links);
    });
  const toggle = () => {
    if (!open) {
      setUrl(null);
      setCopied(false);
      setError(null);
      if (signedIn) loadLinks();
    }
    setOpen((o) => !o);
  };
  const make = () => {
    setBusy(true);
    setError(null);
    void command('hub.shareConversation', { sessionId, messageId, live, expiresIn }).then((r) => {
      setBusy(false);
      if (!r.ok) {
        setError(r.error.message);
        return;
      }
      setUrl(r.value.url);
      void navigator.clipboard?.writeText(r.value.url).then(() => setCopied(true));
      loadLinks();
    });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
    }
  };
  const title = messageId === null ? t.shareTitle : t.shareMessageTitle;

  return (
    <div className={variant === 'header' ? s['wrap'] : l['answerWrap']} ref={wrap} onKeyDown={onKeyDown}>
      <button
        type="button"
        className={variant === 'header' ? s['tool'] : l['answerAct']}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
        data-share-conversation={messageId === null ? 'lane' : 'answer'}
      >
        {t.share}
      </button>
      {open ? (
        <div className={`${s['panel']} ${l['wide']}`} role="dialog" aria-label={title}>
          <span className={s['head']}>{title}</span>
          {!signedIn ? (
            <>
              <p className={s['lead']}>{t.signInToShare}</p>
              <Button variant="accent" onClick={() => void command('hub.signIn', {})}>
                {copy.hub.signIn}
              </Button>
            </>
          ) : (
            <>
              {messageId === null ? (
                <div className={l['seg']} role="group" aria-label={title}>
                  {([false, true] as const).map((v) => (
                    <button
                      key={String(v)}
                      type="button"
                      aria-pressed={live === v}
                      data-inv={live === v ? 'true' : undefined}
                      onClick={() => setLive(v)}
                    >
                      {v ? t.keepUpdating : t.asNow}
                    </button>
                  ))}
                </div>
              ) : null}
              <label className={l['label']} htmlFor={`share-expiry-${sessionId}-${messageId ?? 'all'}`}>
                {t.worksFor}
              </label>
              <select
                id={`share-expiry-${sessionId}-${messageId ?? 'all'}`}
                className={s['input']}
                value={expiresIn}
                onChange={(e) => setExpiresIn(e.currentTarget.value as Expiry)}
              >
                {(['1d', '7d', '30d', 'never'] as const).map((v) => (
                  <option key={v} value={v}>
                    {t.expiry[v]}
                  </option>
                ))}
              </select>
              {url === null ? (
                <Button variant="accent" disabled={busy} onClick={make} data-share-make="true">
                  {busy ? t.making : t.makeLink}
                </Button>
              ) : (
                <div className={l['linkbox']}>
                  <input
                    className={l['url']}
                    readOnly
                    value={url}
                    aria-label={t.copyLink}
                    onFocus={(e) => e.currentTarget.select()}
                    data-share-url="true"
                  />
                  <Button
                    variant="accent"
                    onClick={() => void navigator.clipboard?.writeText(url).then(() => setCopied(true))}
                  >
                    {copied ? t.copied : t.copyLink}
                  </Button>
                </div>
              )}
              <p className={s['hint']}>{t.anyone}</p>
              {error !== null ? (
                <p className={s['error']} role="alert">
                  {error}
                </p>
              ) : null}
              {messageId === null ? (
                <div className={l['links']}>
                  <span className={l['label']}>{t.links}</span>
                  {links.length === 0 ? <span className={l['label']}>{t.noLinks}</span> : null}
                  {links.map((k) => (
                    <div key={k.id} className={l['row']}>
                      <span>
                        {fill(t.linkLine, {
                          scope: t.scope[k.scope],
                          when: ago(k.createdAt),
                          opens: opens(k.opens),
                        })}
                        {k.live ? ` · ${t.liveTag}` : ''}
                      </span>
                      <button
                        type="button"
                        className={s['link']}
                        onClick={() => void command('hub.turnOffLink', { linkId: k.id }).then(loadLinks)}
                        data-share-turn-off={k.id}
                      >
                        {t.turnOff}
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

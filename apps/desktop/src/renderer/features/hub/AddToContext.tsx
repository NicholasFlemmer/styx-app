import { copy, fill, type ReadModel } from '@styx/core';
import { Button } from '@styx/ui';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { command } from '../../state/commands';
import { useModel } from '../../state/hooks';
import s from './HubLaneControl.module.css';
import l from './Lean.module.css';

const t = copy.hub.lean;
const selectTeam = (m: ReadModel) =>
  m.hub.connection.kind === 'signed-in' ? (m.hub.connection.teams[0]?.name ?? '') : null;

/** A first line short enough to title the entry. */
const titleOf = (text: string): string => {
  const first = text.split('\n').find((x) => x.trim() !== '') ?? '';
  const plain = first.replace(/[`*#>_]/g, '').trim();
  return plain.length > 80 ? `${plain.slice(0, 77)}…` : plain;
};

/**
 * Add an answer to team context (the lean hub, mockup frame 3b): a title, decision or note, the words; in at once
 * for the whole team, and every agent can use it in any project.
 */
export function AddToContext({ text }: { text: string }) {
  const team = useModel(selectTeam);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<'decision' | 'doc'>('doc');
  const [state, setState] = useState<'idle' | 'busy' | 'added'>('idle');
  const [error, setError] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current !== null && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const toggle = () => {
    if (!open) {
      setTitle(titleOf(text));
      setBody(text);
      setState('idle');
      setError(null);
    }
    setOpen((o) => !o);
  };
  const add = () => {
    setState('busy');
    void command('hub.addContext', { kind, title: title.trim(), body }).then((r) => {
      if (r.ok) setState('added');
      else {
        setState('idle');
        setError(r.error.message);
      }
    });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className={l['answerWrap']} ref={wrap} onKeyDown={onKeyDown}>
      <button
        type="button"
        className={l['answerAct']}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
        data-add-context="true"
      >
        {t.addToContext}
      </button>
      {open ? (
        <div className={`${s['panel']} ${l['wide']}`} role="dialog" aria-label={t.addTitle}>
          <span className={s['head']}>{t.addTitle}</span>
          {team === null ? (
            <>
              <p className={s['lead']}>{t.signInToShare}</p>
              <Button variant="accent" onClick={() => void command('hub.signIn', {})}>
                {copy.hub.signIn}
              </Button>
            </>
          ) : state === 'added' ? (
            <p className={s['lead']} role="status">
              {t.added}
            </p>
          ) : (
            <>
              <label className={l['label']} htmlFor={`${id}-title`}>
                {t.title}
              </label>
              <input
                id={`${id}-title`}
                className={s['input']}
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.currentTarget.value)}
              />
              <div className={l['seg']} role="group" aria-label={t.kindLabel}>
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
              <label className={l['label']} htmlFor={`${id}-body`}>
                {t.body}
              </label>
              <textarea
                id={`${id}-body`}
                className={`${s['input']} ${l['area']}`}
                value={body}
                maxLength={20000}
                onChange={(e) => setBody(e.currentTarget.value)}
              />
              <p className={s['hint']}>{fill(t.reachesEveryone, { team })}</p>
              {error !== null ? (
                <p className={s['error']} role="alert">
                  {error}
                </p>
              ) : null}
              <Button
                variant="accent"
                disabled={state === 'busy' || title.trim() === ''}
                onClick={add}
                data-add-context-save="true"
              >
                {t.add}
              </Button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

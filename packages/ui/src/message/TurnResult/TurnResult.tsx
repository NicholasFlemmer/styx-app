import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from '../../primitives/Button';
import s from './TurnResult.module.css';

export interface TurnResultLabels {
  showChanges: string;
  undo: string;
  /** The inline question Undo asks first. */
  undoAsk: string;
  undoConfirm: string;
  undoCancel: string;
  /** Beside the actions while the turn stands: "Kept when you carry on". */
  kept: string;
  /** Instead of the actions once undone. */
  undone: string;
  /** Title on Undo while the agent is mid-turn. */
  busy: string;
  before: string;
  after: string;
}

export interface TurnResultProps {
  /** "Done in 4 min". */
  done: string;
  /** "3 files, +42 −3". */
  change: string;
  /** What the agent said it did (its last reply in the turn), rendered by the caller. */
  children?: ReactNode;
  /** Screenshots of the running app around the turn, when Styx took them. */
  before?: string | undefined;
  after?: string | undefined;
  undone: boolean;
  /** The agent is mid-turn: Undo is disabled (main refuses it anyway). */
  busy: boolean;
  labels: TurnResultLabels;
  onShowChanges: () => void;
  onUndo: () => void;
  compact?: boolean;
}

/**
 * A turn's result on paper (ADR-0027 §3): how long it took, what changed, what the agent said, before and after
 * when there are screenshots, then Show changes and Undo this turn. Carrying on keeps the turn. Undo asks first,
 * inline, as the checkpoint row did: the question replaces the actions, Escape or the cancel button puts them
 * back, and only the confirming click dispatches.
 */
export function TurnResult({
  done,
  change,
  children,
  before,
  after,
  undone,
  busy,
  labels,
  onShowChanges,
  onUndo,
  compact = false,
}: TurnResultProps) {
  const [asked, setAsked] = useState(false);
  const confirming = asked && !undone;
  const undoButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
  }, [confirming]);
  const cancel = () => {
    setAsked(false);
    requestAnimationFrame(() => undoButton.current?.focus());
  };
  const onConfirmKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };
  const shots = before !== undefined || after !== undefined;
  return (
    <article
      className={[s['card'], compact ? s['compact'] : undefined].filter(Boolean).join(' ')}
      data-kind="turn-result"
      data-undone={undone ? 'true' : undefined}
      data-confirming={confirming ? 'true' : undefined}
    >
      <header className={s['top']}>
        <span className={s['done']}>{done}</span>
        <span>{change}</span>
      </header>
      {children !== undefined ? <div className={s['body']}>{children}</div> : null}
      {shots ? (
        <div className={s['shots']}>
          {before !== undefined ? (
            <figure className={s['shot']}>
              <figcaption>{labels.before}</figcaption>
              <img src={before} alt={labels.before} />
            </figure>
          ) : null}
          {after !== undefined ? (
            <figure className={s['shot']}>
              <figcaption>{labels.after}</figcaption>
              <img src={after} alt={labels.after} />
            </figure>
          ) : null}
        </div>
      ) : null}
      {undone ? (
        <footer className={s['acts']}>
          <span className={s['undone']}>{labels.undone}</span>
        </footer>
      ) : confirming ? (
        <div
          className={s['acts']}
          role="group"
          aria-label={labels.undo}
          onKeyDown={onConfirmKeyDown}
          data-turn-confirm="true"
        >
          <span className={s['ask']}>{labels.undoAsk}</span>
          <Button
            ref={confirmButton}
            size="compact"
            variant="primary"
            onClick={() => {
              setAsked(false);
              onUndo();
            }}
          >
            {labels.undoConfirm}
          </Button>
          <Button size="compact" onClick={cancel}>
            {labels.undoCancel}
          </Button>
        </div>
      ) : (
        <footer className={s['acts']}>
          <Button size="compact" onClick={onShowChanges}>
            {labels.showChanges}
          </Button>
          <Button
            ref={undoButton}
            size="compact"
            disabled={busy}
            title={busy ? labels.busy : undefined}
            onClick={() => setAsked(true)}
          >
            {labels.undo}
          </Button>
          <span className={s['kept']}>{labels.kept}</span>
        </footer>
      )}
    </article>
  );
}

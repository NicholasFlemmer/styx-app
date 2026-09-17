import { copy, fill } from '@styx/core';
import { Button, Tag } from '@styx/ui';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import s from './CheckpointRow.module.css';

export interface CheckpointRowProps {
  turn: number;
  files: number;
  added: number;
  removed: number;
  /** The workspace was restored to before this turn: no actions, a `Reverted` tag. */
  reverted: boolean;
  /** The agent is mid-turn: Revert is disabled (main refuses it anyway). */
  busy: boolean;
  onReview: () => void;
  onRevert: () => void;
  /** Pop-out chat: smaller type. */
  compact?: boolean;
}

/**
 * One settled turn under the agent's reply (ADR-0020): `Turn n · 3 files · +40 −8 · Review · Revert this turn`.
 * Revert asks first, inline — the question replaces the actions, Escape or Cancel puts them back — and only the
 * confirming click dispatches. Mono, no bubble, like a tool line.
 */
export function CheckpointRow({
  turn,
  files,
  added,
  removed,
  reverted,
  busy,
  onReview,
  onRevert,
  compact = false,
}: CheckpointRowProps) {
  const [asked, setAsked] = useState(false);
  // A turn that became reverted (this one or an earlier one) has nothing left to confirm.
  const confirming = asked && !reverted;
  const setConfirming = setAsked;
  const revertButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const turnLabel = fill(copy.checkpoints.turn, { n: turn });
  const summary = `${turnLabel} · ${fill(copy.checkpoints.changes, { files, added, removed })}`;

  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
  }, [confirming]);

  const cancel = () => {
    setConfirming(false);
    requestAnimationFrame(() => revertButton.current?.focus());
  };
  const onConfirmKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };

  return (
    <div
      className={[s['row'], compact ? s['compact'] : undefined].filter(Boolean).join(' ')}
      data-kind="checkpoint"
      data-turn={turn}
      data-reverted={reverted ? 'true' : undefined}
      data-confirming={confirming ? 'true' : undefined}
    >
      <span className={s['summary']}>{summary}</span>
      {reverted ? (
        <Tag size="md" className={s['tag']}>
          {copy.checkpoints.reverted}
        </Tag>
      ) : confirming ? (
        <span
          className={s['confirm']}
          role="group"
          aria-label={`${copy.checkpoints.revert} · ${turnLabel}`}
          onKeyDown={onConfirmKeyDown}
          data-checkpoint-confirm="true"
        >
          <span className={s['question']}>{fill(copy.checkpoints.revertConfirm, { n: turn })}</span>
          <Button
            ref={confirmButton}
            size="hunk"
            variant="primary"
            className={s['button']}
            aria-label={`${copy.checkpoints.revert} · ${turnLabel} · ${copy.general.yes}`}
            onClick={() => {
              setConfirming(false);
              onRevert();
            }}
          >
            {copy.checkpoints.revert}
          </Button>
          <Button size="hunk" variant="ghost" className={s['button']} onClick={cancel}>
            {copy.general.cancel}
          </Button>
        </span>
      ) : (
        <>
          <Button
            size="hunk"
            variant="ghost"
            className={s['button']}
            aria-label={`${copy.checkpoints.review} · ${turnLabel}`}
            onClick={onReview}
          >
            {copy.checkpoints.review}
          </Button>
          <Button
            ref={revertButton}
            size="hunk"
            variant="ghost"
            className={s['button']}
            aria-label={`${copy.checkpoints.revert} · ${turnLabel}`}
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            {copy.checkpoints.revert}
          </Button>
        </>
      )}
    </div>
  );
}

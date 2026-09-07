import { forwardRef, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from '../../primitives';
import s from './Composer.module.css';

export interface ComposerProps {
  /** e.g. "Message Claude…" (app: `copy.chat.composerPlaceholder`). */
  placeholder: string;
  onSend: (text: string) => void;
  /** t-label hints before the model control (app: `copy.chat.composer.file` / `.command`). */
  hints: readonly string[];
  /** Model picker label; rendered with a ▾ chevron. Omit to hide. */
  modelLabel?: ReactNode;
  /** Send hint label (app: `copy.chat.composer.send`, "⏎ send"). */
  sendLabel: string;
  onModel?: () => void;
  /**
   * Live session controls rendered in the hint row instead of `modelLabel` (t-label selects, Stop): the app's
   * Claude Code parity row (owner addition, discrepancy #54). Same line height as the hint row.
   */
  controls?: ReactNode;
  /** Pop-out chat: 10px 12px padding, 44px min-height, 12.5px type, no hint row. */
  compact?: boolean;
  disabled?: boolean;
  /** Accessible name of the textarea; defaults to the placeholder. */
  ariaLabel?: string;
}

/** Chat composer: bordered `--bg` textarea (min 56px), ⏎ sends, ⇧⏎ inserts a newline, hint row of t-label items. */
export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer(
  {
    placeholder,
    onSend,
    hints,
    modelLabel,
    sendLabel,
    onModel,
    controls,
    compact,
    disabled,
    ariaLabel = placeholder,
  },
  ref,
) {
  const [text, setText] = useState('');
  const inner = useRef<HTMLTextAreaElement | null>(null);
  const setRef = (node: HTMLTextAreaElement | null) => {
    inner.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  };

  const send = () => {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText('');
    inner.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    send();
  };

  return (
    <div className={[s['composer'], compact ? s['compact'] : undefined].filter(Boolean).join(' ')}>
      <textarea
        ref={setRef}
        className={s['input']}
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={text}
        disabled={disabled}
        rows={1}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {!compact && (
        <div className={s['hints']}>
          {(controls === undefined || controls === null) && hints.map((h) => <span key={h}>{h}</span>)}
          {controls !== undefined && controls !== null ? (
            <span className={s['controls']} data-composer-controls="true">
              {controls}
            </span>
          ) : (
            modelLabel !== undefined &&
            modelLabel !== null && (
              <button type="button" className={s['hint']} onClick={onModel} aria-haspopup="menu">
                {modelLabel} <Icon name="chevron" size={8} />
              </button>
            )
          )}
          <span className={s['spacer']} />
          <button
            type="button"
            className={s['hint']}
            onClick={send}
            disabled={disabled || text.trim() === ''}
          >
            {sendLabel}
          </button>
        </div>
      )}
    </div>
  );
});

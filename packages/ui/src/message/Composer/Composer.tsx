import { forwardRef, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from '../../primitives';
import s from './Composer.module.css';

export interface ComposerProps {
  /** e.g. "Message Claude…" */
  placeholder?: string;
  onSend: (text: string) => void;
  /** t-label hints before the model control. Default ['@file', '/command']. */
  hints?: string[];
  /** Model picker label; rendered with a ▾ chevron. Omit to hide. Default "Model". */
  modelLabel?: ReactNode;
  onModel?: () => void;
  /** Pop-out chat: 10px 12px padding, 44px min-height, 12.5px type, no hint row. */
  compact?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
}

/** Chat composer: bordered `--bg` textarea (min 56px), ⏎ sends, ⇧⏎ inserts a newline, hint row of t-label items. */
export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer(
  { placeholder = 'Message…', onSend, hints = ['@file', '/command'], modelLabel = 'Model', onModel, compact, disabled, ariaLabel = 'Message' },
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
          {hints.map((h) => (
            <span key={h}>{h}</span>
          ))}
          {modelLabel !== undefined && modelLabel !== null && (
            <button type="button" className={s['hint']} onClick={onModel} aria-haspopup="menu">
              {modelLabel} <Icon name="chevron" size={8} />
            </button>
          )}
          <span className={s['spacer']} />
          <button type="button" className={s['hint']} onClick={send} disabled={disabled || text.trim() === ''}>
            ⏎ send
          </button>
        </div>
      )}
    </div>
  );
});

import {
  forwardRef,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Icon } from '../../primitives';
import s from './Composer.module.css';
import { ComposerPopup, type PopupItem } from './ComposerPopup';
import { filesFrom, hasFiles, insertToken, tokenAtCaret, type CaretToken } from './composer-tokens';

export interface ComposerAttachment {
  id: string;
  /** Chip text: the image name or file path. */
  label: string;
  kind: 'image' | 'file';
  /** Muted kind prefix on the chip (app: `copy.chat.attach.image` / `.file`). */
  kindLabel?: string;
  /** Accessible name of the × button (app: `copy.chat.attach.remove` filled). */
  removeLabel: string;
}

export interface ComposerProps {
  /** e.g. "Message Claude…" (app: `copy.chat.composerPlaceholder`). */
  placeholder: string;
  /** Trimmed text; may be empty when `canSend` allows sending attachments alone. */
  onSend: (text: string) => void;
  /** t-label hints before the model control (app: `copy.chat.composer.file` / `.command`). */
  hints: readonly string[];
  /** Model picker label; rendered with a ▾ chevron. Omit to hide. */
  modelLabel?: ReactNode;
  /** Send hint label (app: `copy.chat.composer.send`, "⏎ send"; "Queue" / "Steer" while the agent is mid-turn). */
  sendLabel: string;
  /** Tooltip on the send button (app: `copy.queue.queueHint` / `.steerHint` mid-turn). */
  sendTitle?: string;
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

  // --- attachments (owner addition, discrepancy #57) ---
  /** Pending attachments, rendered as a chip row above the textarea. */
  attachments?: readonly ComposerAttachment[];
  onRemoveAttachment?: (id: string) => void;
  /** Sending is allowed with empty text (pending attachments). */
  canSend?: boolean;
  /** Pasted files (image items); when given, a paste that carries files is intercepted. Text paste is unchanged. */
  onPaste?: (files: File[]) => void;
  /** Dropped files; when given, dragging files over the composer shows the drop overlay. */
  onDrop?: (files: File[]) => void;
  /** `Attach` t-label button in the hint row before send (rendered only when given). */
  onAttachClick?: () => void;
  attachLabel?: string;
  /** Drop overlay t-label (app: `copy.chat.attach.dropHint`). */
  dropHint?: string;

  // --- `@file` / `/command` popups ---
  /** Emitted (debounced by the host) whenever the caret sits in an `@…` token; results come back as `mentionItems`. */
  onMentionQuery?: (query: string) => void;
  mentionItems?: readonly PopupItem[];
  /** Fired when a mention is inserted (the host records the file attachment). */
  onMentionInsert?: (id: string) => void;
  mentionHint?: string;
  mentionEmpty?: string;
  /** Emitted whenever the caret sits in a leading `/…` token; results come back as `slashItems`. */
  onSlashQuery?: (query: string) => void;
  /** Present = the session advertises commands; the popup opens on a leading `/`. */
  slashItems?: readonly PopupItem[];
  slashHint?: string;
  slashEmpty?: string;

  // --- draft prefill (queue: Take back / Stop return held messages to the composer) ---
  /**
   * Text handed back to the draft: applied once per `seq` (appended after a blank line when something is already
   * typed, so nothing the user wrote is lost), caret at the end, textarea focused. The host clears it afterwards.
   */
  prefill?: { text: string; seq: number } | null;
}

/**
 * Chat composer: bordered `--bg` textarea (min 56px), ⏎ sends, ⇧⏎ inserts a newline, hint row of t-label items.
 * Attachments chip row, drop overlay, paste capture, and `@` / `/` completion popups are owner additions
 * (docs/handoff-discrepancies #57). Esc while a popup is open closes only the popup (stops propagation).
 */
export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer(
  {
    placeholder,
    onSend,
    hints,
    modelLabel,
    sendLabel,
    sendTitle,
    onModel,
    controls,
    compact,
    disabled,
    ariaLabel = placeholder,
    attachments = [],
    onRemoveAttachment,
    canSend = false,
    onPaste,
    onDrop,
    onAttachClick,
    attachLabel,
    dropHint,
    onMentionQuery,
    mentionItems,
    onMentionInsert,
    mentionHint = '',
    mentionEmpty = '',
    onSlashQuery,
    slashItems,
    slashHint = '',
    slashEmpty = '',
    prefill = null,
  },
  ref,
) {
  const [text, setText] = useState('');
  const appliedPrefill = useRef<number | null>(null);
  const [caret, setCaret] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const pendingCaret = useRef<number | null>(null);
  const inner = useRef<HTMLTextAreaElement | null>(null);
  const popupId = useId();
  const setRef = (node: HTMLTextAreaElement | null) => {
    inner.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  };

  const mentionEnabled = onMentionQuery !== undefined || mentionItems !== undefined;
  const slashEnabled = slashItems !== undefined;
  const token: CaretToken | null = useMemo(() => {
    const t = tokenAtCaret(text, caret);
    if (t === null) return null;
    if (t.kind === 'mention' && !mentionEnabled) return null;
    if (t.kind === 'slash' && !slashEnabled) return null;
    return t;
  }, [text, caret, mentionEnabled, slashEnabled]);
  const popupOpen = token !== null && token.start !== dismissedAt && !disabled;
  const items: readonly PopupItem[] = useMemo(
    () => (token === null ? [] : token.kind === 'mention' ? (mentionItems ?? []) : (slashItems ?? [])),
    [token, mentionItems, slashItems],
  );

  // Reset the dismissal once the caret leaves the token; the host learns the query when it changes.
  useEffect(() => {
    if (token === null) setDismissedAt(null);
  }, [token]);
  const tokenKind = token?.kind;
  const tokenQuery = token?.query;
  useEffect(() => {
    if (tokenKind === 'mention' && tokenQuery !== undefined) onMentionQuery?.(tokenQuery);
    if (tokenKind === 'slash' && tokenQuery !== undefined) onSlashQuery?.(tokenQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the host callbacks are identity-unstable by design
  }, [tokenKind, tokenQuery]);
  useEffect(() => {
    setActive(0);
  }, [items]);
  useEffect(() => {
    const c = pendingCaret.current;
    if (c !== null && inner.current !== null) {
      inner.current.setSelectionRange(c, c);
      pendingCaret.current = null;
    }
  }, [text]);
  useEffect(() => {
    if (prefill === null || prefill.seq === appliedPrefill.current) return;
    appliedPrefill.current = prefill.seq;
    const next = text.trim() === '' ? prefill.text : `${text.replace(/\s+$/, '')}\n\n${prefill.text}`;
    pendingCaret.current = next.length;
    setText(next);
    setCaret(next.length);
    inner.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the draft is read once, when a new prefill arrives
  }, [prefill]);

  const optionId = (i: number) => `${popupId}-opt-${i}`;

  const send = () => {
    const t = text.trim();
    if ((t === '' && !canSend) || disabled) return;
    onSend(t);
    setText('');
    setCaret(0);
    inner.current?.focus();
  };

  const pick = (item: PopupItem) => {
    if (token === null) return;
    const trigger = token.kind === 'mention' ? '@' : '/';
    const next = insertToken(text, token, item.label.startsWith(trigger) ? item.label : trigger + item.label);
    pendingCaret.current = next.caret;
    setText(next.text);
    setCaret(next.caret);
    setDismissedAt(null);
    if (token.kind === 'mention') onMentionInsert?.(item.id);
    inner.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (popupOpen && token !== null) {
      if (e.key === 'Escape') {
        // The popup owns Esc: close it without reaching the session's interrupt binding.
        e.preventDefault();
        e.stopPropagation();
        setDismissedAt(token.start);
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (items.length === 0) return;
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        setActive((a) => (a + delta + items.length) % items.length);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        const item = items[active];
        if (item !== undefined) {
          e.preventDefault();
          pick(item);
          return;
        }
      }
    }
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    send();
  };

  const onPasteEvent = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (onPaste === undefined) return;
    const files = filesFrom(e.clipboardData);
    if (files.length === 0) return;
    e.preventDefault();
    onPaste(files);
  };

  const dragProps =
    onDrop === undefined || disabled
      ? {}
      : {
          onDragEnter: (e: DragEvent<HTMLDivElement>) => {
            if (!hasFiles(e.dataTransfer)) return;
            e.preventDefault();
            dragDepth.current += 1;
            setDragging(true);
          },
          onDragOver: (e: DragEvent<HTMLDivElement>) => {
            if (!hasFiles(e.dataTransfer)) return;
            e.preventDefault();
          },
          onDragLeave: () => {
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDragging(false);
          },
          onDrop: (e: DragEvent<HTMLDivElement>) => {
            e.preventDefault();
            dragDepth.current = 0;
            setDragging(false);
            const files = filesFrom(e.dataTransfer);
            if (files.length > 0) onDrop(files);
          },
        };

  const sendDisabled = disabled || (text.trim() === '' && !canSend);
  const activeItem = items[active];

  return (
    <div
      className={[s['composer'], compact ? s['compact'] : undefined].filter(Boolean).join(' ')}
      data-dragging={dragging ? 'true' : undefined}
      {...dragProps}
    >
      {attachments.length > 0 && (
        <div className={s['chips']} data-composer-attachments="true">
          {attachments.map((a) => (
            <span key={a.id} className={s['chip']} data-kind={a.kind}>
              {a.kindLabel !== undefined && a.kindLabel !== '' && (
                <span className={s['chipKind']}>{a.kindLabel}</span>
              )}
              <span className={s['chipLabel']} title={a.label}>
                {a.label}
              </span>
              {onRemoveAttachment !== undefined && (
                <button
                  type="button"
                  className={s['chipRemove']}
                  aria-label={a.removeLabel}
                  onClick={() => onRemoveAttachment(a.id)}
                >
                  <Icon name="close" size={8} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      <div className={s['field']}>
        {popupOpen && token !== null && (
          <ComposerPopup
            id={popupId}
            kind={token.kind}
            hint={token.kind === 'mention' ? mentionHint : slashHint}
            emptyLabel={token.kind === 'mention' ? mentionEmpty : slashEmpty}
            items={items}
            activeIndex={active}
            optionId={optionId}
            onPick={pick}
            onActivate={setActive}
          />
        )}
        <textarea
          ref={setRef}
          className={s['input']}
          aria-label={ariaLabel}
          placeholder={placeholder}
          value={text}
          disabled={disabled}
          rows={1}
          aria-autocomplete={mentionEnabled || slashEnabled ? 'list' : undefined}
          aria-controls={popupOpen ? popupId : undefined}
          aria-activedescendant={popupOpen && activeItem !== undefined ? optionId(active) : undefined}
          data-popup={popupOpen && token !== null ? token.kind : undefined}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onBlur={() => {
            if (token !== null) setDismissedAt(token.start);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPasteEvent}
        />
      </div>
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
          {onAttachClick !== undefined && (
            <button
              type="button"
              className={s['hint']}
              onClick={onAttachClick}
              disabled={disabled}
              data-composer-attach="true"
            >
              {attachLabel}
            </button>
          )}
          <button
            type="button"
            className={s['hint']}
            onClick={send}
            disabled={sendDisabled}
            title={sendTitle}
            data-composer-send="true"
          >
            {sendLabel}
          </button>
        </div>
      )}
      {dragging && (
        <div className={s['drop']} aria-hidden="true">
          <span className={s['dropHint']}>{dropHint}</span>
        </div>
      )}
    </div>
  );
});

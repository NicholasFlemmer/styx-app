import { useEffect, useRef } from 'react';
import s from './ComposerPopup.module.css';

export interface PopupItem {
  id: string;
  /** Row text: a path for mentions, `/name` for commands. */
  label: string;
  /** One-line description (known built-in commands). */
  hint?: string;
}

export interface ComposerPopupProps {
  /** `aria-controls` target of the textarea. */
  id: string;
  kind: 'mention' | 'slash';
  /** Header t-label (app: `copy.chat.mention.hint` / `copy.chat.slash.hint`). */
  hint: string;
  /** Shown when `items` is empty (app: `copy.chat.mention.none` / `copy.chat.slash.none`). */
  emptyLabel: string;
  items: readonly PopupItem[];
  activeIndex: number;
  optionId: (index: number) => string;
  onPick: (item: PopupItem) => void;
  onActivate: (index: number) => void;
}

/**
 * Anchored list above the composer textarea for `@file` / `/command` completion (owner addition,
 * docs/handoff-discrepancies #57): `--s1`, 1px `--tx` border, header t-label, up to 8 visible 26px rows
 * (mono 12px labels, muted hints), the active row inverted. Keyboard lives in the Composer
 * (`aria-activedescendant`); rows take the pointer without stealing focus.
 */
export function ComposerPopup({
  id,
  kind,
  hint,
  emptyLabel,
  items,
  activeIndex,
  optionId,
  onPick,
  onActivate,
}: ComposerPopupProps) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = list.current?.querySelector<HTMLElement>('[data-active="true"]');
    if (row !== null && row !== undefined && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex, items]);

  return (
    <div id={id} className={s['popup']} data-composer-popup={kind}>
      <div className={s['head']}>{hint}</div>
      {items.length === 0 ? (
        <div className={s['empty']}>{emptyLabel}</div>
      ) : (
        <div ref={list} role="listbox" aria-label={hint} className={s['list']}>
          {items.map((item, i) => {
            const active = i === activeIndex;
            return (
              <div
                key={item.id}
                id={optionId(i)}
                role="option"
                aria-selected={active}
                data-active={active ? 'true' : undefined}
                data-inv={active ? 'true' : undefined}
                className={s['row']}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => onActivate(i)}
                onClick={() => onPick(item)}
              >
                <span className={s['label']}>{item.label}</span>
                {item.hint !== undefined && item.hint !== '' && (
                  <span className={s['hint']} data-muted="true">
                    {item.hint}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

import { forwardRef, useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useEscape } from '../../hooks';
import s from './PaletteList.module.css';

export interface PaletteItem {
  id: string;
  /** Mono glyph in the 14px lead column, e.g. "→ ▲ ◆ ●". */
  glyph: ReactNode;
  label: ReactNode;
  /** Mono meta, e.g. "open · 58m", "needs you". */
  meta?: ReactNode;
}

export interface PaletteGroup {
  id: string;
  /** Actions · Agents · Projects (spec §5). */
  label: ReactNode;
  items: PaletteItem[];
}

export interface PaletteListProps {
  query: string;
  onQuery: (q: string) => void;
  groups: PaletteGroup[];
  /** Highlighted (inverted) row; DOM focus stays on the input. */
  activeId?: string | undefined;
  onActive: (id: string) => void;
  onRun: (id: string) => void;
  /** Prompt placeholder (app: `copy.palette.placeholder`). */
  placeholder: string;
  /** t-label hints; the last one sits after a spacer ("esc"). */
  footerHints: readonly string[];
  /** ⇥ cycles scope (spec §5); +1 for Tab, -1 for Shift+Tab. */
  onScopeCycle?: (dir: 1 | -1) => void;
  /** When given, Esc calls it (topmost overlay only). */
  onClose?: () => void;
  /** Accessible name of the dialog (app: `copy.palette.dialogLabel`). */
  ariaLabel: string;
  /** Accessible name of the results listbox (app: `copy.palette.resultsLabel`). */
  resultsLabel: string;
}

/** Command palette panel: 640px, `--tx` border, mono prompt with accent `>`, grouped listbox (spec §5). */
export const PaletteList = forwardRef<HTMLDivElement, PaletteListProps>(function PaletteList(
  {
    query,
    onQuery,
    groups,
    activeId,
    onActive,
    onRun,
    placeholder,
    footerHints,
    onScopeCycle,
    onClose,
    ariaLabel,
    resultsLabel,
  },
  ref,
) {
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (id: string) => `${baseId}-opt-${id}`;
  const input = useRef<HTMLInputElement>(null);
  /** Last pointer position over the list: a row is hover-selected only when the pointer actually moved. */
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const flat = groups.flatMap((g) => g.items.map((i) => i.id));
  const activeIndex = activeId === undefined ? -1 : flat.indexOf(activeId);
  const activeOptionId = activeId !== undefined && activeIndex >= 0 ? optionId(activeId) : undefined;

  useEscape(onClose !== undefined, () => onClose?.(), onClose !== undefined);
  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    if (activeOptionId === undefined) return;
    const el = document.getElementById(activeOptionId);
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [activeOptionId]);

  const move = (delta: 1 | -1) => {
    if (flat.length === 0) return;
    const next =
      activeIndex < 0
        ? delta === 1
          ? 0
          : flat.length - 1
        : (activeIndex + delta + flat.length) % flat.length;
    const id = flat[next];
    if (id !== undefined) onActive(id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        break;
      case 'Enter': {
        const id = activeId ?? flat[0];
        if (id !== undefined) {
          e.preventDefault();
          onRun(id);
        }
        break;
      }
      case 'Tab':
        if (onScopeCycle) {
          e.preventDefault();
          onScopeCycle(e.shiftKey ? -1 : 1);
        }
        break;
      default:
        break;
    }
  };

  const lastHint = footerHints.length - 1;

  return (
    <div ref={ref} className={s['panel']} aria-label={ariaLabel}>
      <div className={s['prompt']}>
        <span className={s['caret']} aria-hidden="true">
          &gt;
        </span>
        <input
          ref={input}
          className={s['input']}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={activeOptionId}
          aria-autocomplete="list"
          aria-label={ariaLabel}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          value={query}
          placeholder={placeholder}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div id={listId} role="listbox" aria-label={resultsLabel} className={s['list']}>
        {groups.map((g) => {
          const gid = `${baseId}-grp-${g.id}`;
          return (
            <div key={g.id} role="group" aria-labelledby={gid}>
              <div id={gid} className={s['group']}>
                {g.label}
              </div>
              {g.items.map((i) => {
                const active = i.id === activeId;
                return (
                  <div
                    key={i.id}
                    id={optionId(i.id)}
                    role="option"
                    aria-selected={active}
                    data-inv={active ? 'true' : undefined}
                    className={s['row']}
                    onMouseMove={(e) => {
                      // Chromium re-dispatches mousemove after layout under a stationary pointer (and the OS does on
                      // window show); only a real move steals the selection from the keyboard.
                      const last = pointer.current;
                      pointer.current = { x: e.clientX, y: e.clientY };
                      if (last === null || (last.x === e.clientX && last.y === e.clientY)) return;
                      if (!active) onActive(i.id);
                    }}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onRun(i.id)}
                  >
                    <span className={s['glyph']} data-muted="true">
                      {i.glyph}
                    </span>
                    <span className={s['label']}>{i.label}</span>
                    {i.meta !== undefined && <span className={s['meta']}>{i.meta}</span>}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {footerHints.length > 0 && (
        <div className={s['hints']}>
          {footerHints.map((h, idx) => (
            <span key={h} className={idx === lastHint && idx > 0 ? s['hintLast'] : undefined}>
              {h}
            </span>
          ))}
        </div>
      )}
    </div>
  );
});

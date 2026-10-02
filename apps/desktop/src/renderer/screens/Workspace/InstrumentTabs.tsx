import { copy, fill, instrumentOrderOf, type Instrument } from '@styx/core';
import { Tab } from '@styx/ui';
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { command } from '../../state/commands';
import { useModel } from '../../state/hooks';
import { INSTRUMENT_LABEL, moveInstrument } from './instruments';
import s from './Workspace.module.css';

export interface InstrumentTabsProps {
  mode: Instrument;
  onPick: (next: Instrument) => void;
}

/** The tab button for an instrument (focus follows a moved tab). */
const tabOf = (key: Instrument) =>
  document.querySelector<HTMLButtonElement>(`[data-instruments] [data-workspace-mode="${key}"]`);

const saveOrder = (order: Instrument[]) =>
  void command('settings.set', { patch: { instrumentOrder: order } });

/**
 * The workspace's tabs in the person's order (#140): drag a tab to move it; right-click (or Shift+F10) for Move left,
 * Move right, Move to front and Reset order; Alt+Shift+←/→ moves the focused tab. Kept for every project.
 */
export function InstrumentTabs({ mode, onPick }: InstrumentTabsProps) {
  const stored = useModel((m) => m.settings.app.instrumentOrder);
  const order = instrumentOrderOf(stored);
  const [dragging, setDragging] = useState<Instrument | null>(null);
  const [gap, setGap] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ key: Instrument; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const move = (key: Instrument, to: number, focus = false) => {
    const next = moveInstrument(order, key, to);
    saveOrder(next);
    if (focus) requestAnimationFrame(() => tabOf(key)?.focus());
  };

  useEffect(() => {
    if (menu === null) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);

  const onKeyDown = (key: Instrument, e: KeyboardEvent<HTMLButtonElement>) => {
    const i = order.indexOf(key);
    if (e.altKey && e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      move(key, e.key === 'ArrowLeft' ? i - 1 : i + 1, true);
      return;
    }
    if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      setMenu({ key, x: r.left, y: r.bottom });
    }
  };

  const onDragOver = (index: number, e: DragEvent<HTMLButtonElement>) => {
    if (dragging === null) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    setGap(e.clientX < r.left + r.width / 2 ? index : index + 1);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    if (dragging !== null && gap !== null) {
      const from = order.indexOf(dragging);
      move(dragging, gap > from ? gap - 1 : gap);
    }
    setDragging(null);
    setGap(null);
  };

  const item = (label: string, run: () => void, disabled = false) => (
    <button
      type="button"
      role="menuitem"
      className={s['tabMenuItem']}
      disabled={disabled}
      onClick={() => {
        run();
        setMenu(null);
      }}
    >
      {label}
    </button>
  );

  return (
    <>
      <div
        className={s['tabs']}
        role="tablist"
        aria-label={copy.chat.instruments.label}
        data-instruments="true"
        onDrop={onDrop}
        onDragOver={(e) => {
          if (dragging !== null) e.preventDefault();
        }}
      >
        {order.map((key, index) => (
          <Tab
            key={key}
            variant="approvals"
            label={INSTRUMENT_LABEL[key]}
            inv={mode === key}
            onClick={() => onPick(key)}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', key);
              setDragging(key);
            }}
            onDragEnd={() => {
              setDragging(null);
              setGap(null);
            }}
            onDragOver={(e) => onDragOver(index, e)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ key, x: e.clientX, y: e.clientY });
            }}
            onKeyDown={(e) => onKeyDown(key, e)}
            aria-haspopup="menu"
            className={[
              dragging === key ? s['tabDragging'] : undefined,
              gap === index && dragging !== null ? s['tabGapBefore'] : undefined,
              gap === index + 1 && index === order.length - 1 && dragging !== null
                ? s['tabGapAfter']
                : undefined,
            ]
              .filter(Boolean)
              .join(' ')}
            data-workspace-mode={key}
          />
        ))}
      </div>
      {menu !== null ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label={fill(copy.chat.order.menu, { tab: INSTRUMENT_LABEL[menu.key] })}
          className={s['tabMenu']}
          style={{ left: menu.x, top: menu.y }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              const key = menu.key;
              setMenu(null);
              tabOf(key)?.focus();
            }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const items = [
                ...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
                  '[role="menuitem"]:not(:disabled)',
                ) ?? []),
              ];
              const at = items.indexOf(document.activeElement as HTMLButtonElement);
              items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
            }
          }}
          data-tab-menu={menu.key}
        >
          {item(
            copy.chat.order.moveLeft,
            () => move(menu.key, order.indexOf(menu.key) - 1, true),
            order.indexOf(menu.key) === 0,
          )}
          {item(
            copy.chat.order.moveRight,
            () => move(menu.key, order.indexOf(menu.key) + 1, true),
            order.indexOf(menu.key) === order.length - 1,
          )}
          {item(copy.chat.order.moveFront, () => move(menu.key, 0, true), order.indexOf(menu.key) === 0)}
          {item(copy.chat.order.reset, () => saveOrder([]), stored.length === 0)}
        </div>
      ) : null}
    </>
  );
}

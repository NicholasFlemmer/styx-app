import {
  copy,
  fill,
  flattenPalette,
  nextPaletteScope,
  PALETTE_SCOPES,
  paletteResults,
  platformCopy,
  type PaletteScope,
} from '@styx/core';
import { sizes } from '@styx/tokens';
import { Backdrop, PaletteList } from '@styx/ui';
import { useCallback, useMemo, useRef, type KeyboardEvent } from 'react';
import { useNow, useUi, useUiShallow } from '../../state/hooks';
import { useReadModel } from '../../state/read-model';
import { runPaletteAction } from './actions';

export interface PaletteProps {
  /** Overlay id from the stack. */
  id: string;
}

const prevScope = (scope: PaletteScope): PaletteScope => {
  const i = PALETTE_SCOPES.indexOf(scope);
  return PALETTE_SCOPES[(i - 1 + PALETTE_SCOPES.length) % PALETTE_SCOPES.length] ?? 'all';
};

/** Command palette (spec §5): core `paletteResults` rendered through `PaletteList`; ⇥ cycles scope, Mod+⏎ new window. */
export function Palette({ id }: PaletteProps) {
  const model = useReadModel((s) => s.model);
  const now = useNow();
  const projectId = useUi((s) => s.projectId);
  const platform = useUi((s) => s.platform);
  const palette = useUiShallow((s) => s.palette);
  const setPalette = useUi((s) => s.setPalette);
  const popOverlay = useUi((s) => s.popOverlay);
  const newWindow = useRef(false);

  const groups = useMemo(
    () => paletteResults(model, { projectId }, palette.query, palette.scope, now),
    [model, projectId, palette.query, palette.scope, now],
  );
  const flat = useMemo(() => flattenPalette(groups), [groups]);
  const activeId = flat.some((i) => i.id === palette.activeId)
    ? (palette.activeId ?? undefined)
    : flat[0]?.id;

  const listGroups = useMemo(
    () =>
      groups.map((g) => ({
        id: g.key,
        label: g.label,
        items: g.items.map((i) => ({ id: i.id, glyph: i.glyph, label: i.label, meta: i.meta })),
      })),
    [groups],
  );

  const close = useCallback(() => popOverlay(id), [popOverlay, id]);

  const run = (itemId: string) => {
    const item = flat.find((i) => i.id === itemId);
    if (item === undefined) return;
    runPaletteAction(item.action, { newWindow: newWindow.current, paletteId: id });
    newWindow.current = false;
  };

  const onKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = platform === 'darwin' ? e.metaKey : e.ctrlKey;
    newWindow.current = e.key === 'Enter' && mod;
  };

  const hints = [
    copy.palette.footer.run,
    fill(copy.palette.footer.newWindow, { mod: platformCopy(platform).mod }),
    copy.palette.footer.scope,
    copy.palette.footer.close,
  ];

  return (
    <Backdrop paddingTop={sizes.paletteTop} onClose={close}>
      <div data-keyscope="palette" data-overlay="palette" onKeyDownCapture={onKeyDownCapture}>
        <PaletteList
          query={palette.query}
          onQuery={(q) => setPalette({ query: q, activeId: null })}
          groups={listGroups}
          activeId={activeId}
          onActive={(activeId) => setPalette({ activeId })}
          onRun={run}
          placeholder={copy.palette.placeholder}
          footerHints={hints}
          onScopeCycle={(dir) =>
            setPalette({
              scope: dir === 1 ? nextPaletteScope(palette.scope) : prevScope(palette.scope),
              activeId: null,
            })
          }
        />
      </div>
    </Backdrop>
  );
}

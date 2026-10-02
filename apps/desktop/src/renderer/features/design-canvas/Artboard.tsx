import { DESIGN_WIDTH, copy, type DesignFile, type WorktreeId } from '@styx/core';
import { useEffect, useRef, useState } from 'react';
import { command } from '../../state/commands';
import {
  HOVER_ATTR,
  PICKED_ATTR,
  TOKENS_STYLE,
  areaTag,
  buildSrcdoc,
  elementsInRect,
  type CanvasSelection,
} from './design-doc';
import s from './DesignCanvas.module.css';

export interface ArtboardProps {
  worktreeId: WorktreeId;
  file: DesignFile;
  /** Bumped when the file changed on disk (not by our own save): the frame reloads. */
  version: number;
  zoom: number;
  selecting: boolean;
  /** The tokens being edited in Type and colour, applied live; null = the file's own. */
  liveCss: string | null;
  selection: CanvasSelection | null;
  onSelect: (sel: CanvasSelection | null) => void;
}

const MIN_HEIGHT = 480;
const MAX_HEIGHT = 6000;

/**
 * One screen at one size (#140), drawn in a frame with no scripts (`sandbox="allow-same-origin"`), so the canvas can
 * read and edit its document. With Select on, hover outlines, a click picks the element, a drag picks an area.
 */
export function Artboard({
  worktreeId,
  file,
  version,
  zoom,
  selecting,
  liveCss,
  selection,
  onSelect,
}: ArtboardProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [srcdoc, setSrcdoc] = useState<string | null>(null);
  const [height, setHeight] = useState(MIN_HEIGHT);
  const [marquee, setMarquee] = useState<{ x: number; y: number; width: number; height: number } | null>(
    null,
  );
  const width = DESIGN_WIDTH[file.size];
  // The frame's listeners are attached once per load; they read the latest props through these.
  const selectingRef = useRef(selecting);
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    selectingRef.current = selecting;
    onSelectRef.current = onSelect;
  });

  useEffect(() => {
    let live = true;
    void command('design.read', { worktreeId, path: file.path }).then((r) => {
      if (live && r.ok) setSrcdoc(buildSrcdoc(r.value.html, r.value.css));
    });
    return () => {
      live = false;
    };
  }, [worktreeId, file.path, version]);

  // Type and colour edits show at once, before they are saved.
  useEffect(() => {
    const style = frame.current?.contentDocument?.querySelector(`[${TOKENS_STYLE}]`);
    if (style && liveCss !== null) style.textContent = liveCss;
  }, [liveCss, srcdoc]);

  // The picked element wears the outline; nothing else does.
  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    for (const el of doc.querySelectorAll(`[${PICKED_ATTR}]`)) el.removeAttribute(PICKED_ATTR);
    if (
      selection?.kind === 'element' &&
      selection.file.path === file.path &&
      selection.el.ownerDocument === doc
    )
      selection.el.setAttribute(PICKED_ATTR, '');
  }, [selection, file.path, srcdoc]);

  useEffect(() => {
    if (selecting) return;
    const doc = frame.current?.contentDocument;
    for (const el of doc?.querySelectorAll(`[${HOVER_ATTR}]`) ?? []) el.removeAttribute(HOVER_ATTR);
  }, [selecting]);

  const onLoad = () => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    const measure = () =>
      setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, doc.documentElement.scrollHeight)));
    measure();
    setTimeout(measure, 300);
    let start: { x: number; y: number } | null = null;
    let hovered: Element | null = null;
    const hover = (el: Element | null) => {
      hovered?.removeAttribute(HOVER_ATTR);
      hovered = el;
      el?.setAttribute(HOVER_ATTR, '');
    };
    const target = (e: MouseEvent): Element | null => {
      // The frame's Element is another realm's: tell elements by node type, not instanceof.
      const node = e.target as Node | null;
      const el = node !== null && node.nodeType === 1 ? (node as Element) : null;
      return el === null || el === doc.documentElement || el === doc.body ? null : el;
    };
    // Links and buttons never act in a design: the frame stays on its screen.
    doc.addEventListener('click', (e) => e.preventDefault(), true);
    doc.addEventListener('submit', (e) => e.preventDefault(), true);
    doc.addEventListener('mousemove', (e) => {
      if (!selectingRef.current) return;
      if (start !== null) {
        hover(null);
        setMarquee({
          x: Math.min(start.x, e.clientX),
          y: Math.min(start.y, e.clientY) + doc.documentElement.scrollTop,
          width: Math.abs(e.clientX - start.x),
          height: Math.abs(e.clientY - start.y),
        });
      } else hover(target(e));
    });
    doc.addEventListener('mouseleave', () => hover(null));
    doc.addEventListener('mousedown', (e) => {
      if (!selectingRef.current || e.button !== 0) return;
      e.preventDefault();
      start = { x: e.clientX, y: e.clientY };
    });
    doc.addEventListener('mouseup', (e) => {
      if (!selectingRef.current || start === null) return;
      const s0 = start;
      start = null;
      setMarquee(null);
      if (Math.abs(e.clientX - s0.x) < 5 && Math.abs(e.clientY - s0.y) < 5) {
        const el = target(e);
        onSelectRef.current(
          el === null ? null : { kind: 'element', file, el, rect: el.getBoundingClientRect() },
        );
        return;
      }
      const rect = {
        x: Math.min(s0.x, e.clientX),
        y: Math.min(s0.y, e.clientY),
        width: Math.abs(e.clientX - s0.x),
        height: Math.abs(e.clientY - s0.y),
      };
      onSelectRef.current({ kind: 'area', file, els: elementsInRect(doc, rect), rect });
    });
  };

  const area = selection?.kind === 'area' && selection.file.path === file.path ? selection : null;
  const drawing = selecting ? marquee : null;
  const box = drawing ?? area?.rect ?? null;
  const n = drawing === null ? (area?.els.length ?? 0) : null;

  return (
    <div className={s['artboard']} data-artboard={file.path}>
      <div className={s['abLabel']}>
        <b>{copy.chat.design.size[file.size]}</b>
        {file.fidelity === 'wire' ? <span>{copy.chat.design.wireframe}</span> : null}
      </div>
      <div
        className={s['abFrame']}
        style={{ width: width * zoom, height: height * zoom }}
        data-selecting={selecting ? 'true' : undefined}
      >
        {srcdoc !== null ? (
          <iframe
            ref={frame}
            title={`${file.screen} ${file.size}`}
            sandbox="allow-same-origin"
            srcDoc={srcdoc}
            onLoad={onLoad}
            className={s['abIframe']}
            style={{ width, height, transform: `scale(${zoom})` }}
            tabIndex={-1}
          />
        ) : null}
        {box !== null ? (
          <div
            className={s['area']}
            style={{
              left: box.x * zoom,
              top: box.y * zoom,
              width: box.width * zoom,
              height: box.height * zoom,
            }}
            data-area={drawing === null ? 'picked' : 'drawing'}
          >
            {n !== null ? <span className={s['areaTag']}>{areaTag(n, box.width, box.height)}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

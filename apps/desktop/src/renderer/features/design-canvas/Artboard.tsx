import { DESIGN_WIDTH, copy, fill, type DesignFile, type WorktreeId } from '@styx/core';
import {
  memo,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
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

/** A wheel turned over a frame, in the main window's coordinates (the frame's own are its unscaled page). */
export interface FrameWheel {
  clientX: number;
  clientY: number;
  deltaX: number;
  deltaY: number;
  deltaMode: 0 | 1 | 2;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export interface ArtboardProps {
  worktreeId: WorktreeId;
  file: DesignFile;
  /** The screen's name, for the board's name above it. */
  screen: string;
  /** Bumped when the file changed on disk (not by our own save): the frame reloads. */
  version: number;
  /** Where the board sits on the canvas (canvas px). */
  x: number;
  y: number;
  selecting: boolean;
  /**
   * The frame takes no pointer or wheel events (Select is off, or the canvas is being panned): the stage under it gets
   * them, so a gesture over a screen moves the canvas instead of disappearing into the frame.
   */
  inert: boolean;
  moving: boolean;
  /** The id of the hidden text that says how to move a board, for its name's description. */
  moveHintId: string;
  /** The tokens being edited in Type and colour, applied live; null = the file's own. */
  liveCss: string | null;
  selection: CanvasSelection | null;
  onSelect: (sel: CanvasSelection | null) => void;
  onHeight: (path: string, height: number) => void;
  onHandlePointerDown: (path: string, e: ReactPointerEvent<HTMLButtonElement>) => void;
  onHandleKeyDown: (path: string, e: ReactKeyboardEvent<HTMLButtonElement>) => void;
  /** A board's name took keyboard focus: the canvas brings the board into view. */
  onHandleFocus: (path: string) => void;
  onFrameWheel: (e: FrameWheel) => void;
  /** A middle-button press inside a frame (Select on): the canvas starts panning from there. */
  onFramePan: (clientX: number, clientY: number) => void;
}

const MIN_HEIGHT = 480;
const MAX_HEIGHT = 6000;

/**
 * One screen at one size (row 140) on the freeform canvas (ADR-0030), drawn in a frame with no scripts
 * (`sandbox="allow-same-origin"`), so the canvas can read and edit its document. Its name above it is the handle that
 * moves it. With Select on, hover outlines, a click picks the element, a drag picks an area; positions inside the frame
 * are the page's own, so a pick is the same at any zoom or pan.
 */
export const Artboard = memo(function Artboard({
  worktreeId,
  file,
  screen,
  version,
  x,
  y,
  selecting,
  inert,
  moving,
  moveHintId,
  liveCss,
  selection,
  onSelect,
  onHeight,
  onHandlePointerDown,
  onHandleKeyDown,
  onHandleFocus,
  onFrameWheel,
  onFramePan,
}: ArtboardProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [srcdoc, setSrcdoc] = useState<string | null>(null);
  const [height, setHeight] = useState(MIN_HEIGHT);
  const [marquee, setMarquee] = useState<{ x: number; y: number; width: number; height: number } | null>(
    null,
  );
  const width = DESIGN_WIDTH[file.size];
  const d = copy.chat.design;
  // The frame's listeners are attached once per load; they read the latest props through these.
  const latest = useRef({ selecting, onSelect, onFrameWheel, onFramePan });
  useEffect(() => {
    latest.current = { selecting, onSelect, onFrameWheel, onFramePan };
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

  useEffect(() => {
    onHeight(file.path, height);
  }, [onHeight, file.path, height]);

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
    const el = frame.current;
    const doc = el?.contentDocument;
    if (!el || !doc) return;
    const measure = () =>
      setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, doc.documentElement.scrollHeight)));
    measure();
    setTimeout(measure, 300);
    /** A point in the frame's page, in the main window: the frame is drawn scaled by the canvas's zoom. */
    const toWindow = (cx: number, cy: number) => {
      const r = el.getBoundingClientRect();
      const k = el.offsetWidth > 0 ? r.width / el.offsetWidth : 1;
      return { x: r.left + cx * k, y: r.top + cy * k };
    };
    let start: { x: number; y: number } | null = null;
    let hovered: Element | null = null;
    const hover = (h: Element | null) => {
      hovered?.removeAttribute(HOVER_ATTR);
      hovered = h;
      h?.setAttribute(HOVER_ATTR, '');
    };
    const target = (e: MouseEvent): Element | null => {
      // The frame's Element is another realm's: tell elements by node type, not instanceof.
      const node = e.target as Node | null;
      const t = node !== null && node.nodeType === 1 ? (node as Element) : null;
      return t === null || t === doc.documentElement || t === doc.body ? null : t;
    };
    // Links and buttons never act in a design: the frame stays on its screen.
    doc.addEventListener('click', (e) => e.preventDefault(), true);
    doc.addEventListener('submit', (e) => e.preventDefault(), true);
    // The page never scrolls or zooms itself: a wheel over it is the canvas's (Select on; otherwise it never gets here).
    doc.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const p = toWindow(e.clientX, e.clientY);
        latest.current.onFrameWheel({
          clientX: p.x,
          clientY: p.y,
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          deltaMode: e.deltaMode === 1 ? 1 : e.deltaMode === 2 ? 2 : 0,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          shiftKey: e.shiftKey,
        });
      },
      { passive: false },
    );
    doc.addEventListener('mousemove', (e) => {
      if (!latest.current.selecting) return;
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
      if (e.button === 1) {
        e.preventDefault();
        const p = toWindow(e.clientX, e.clientY);
        latest.current.onFramePan(p.x, p.y);
        return;
      }
      if (!latest.current.selecting || e.button !== 0) return;
      e.preventDefault();
      start = { x: e.clientX, y: e.clientY };
    });
    doc.addEventListener('mouseup', (e) => {
      if (!latest.current.selecting || start === null) return;
      const s0 = start;
      start = null;
      setMarquee(null);
      if (Math.abs(e.clientX - s0.x) < 5 && Math.abs(e.clientY - s0.y) < 5) {
        const picked = target(e);
        latest.current.onSelect(
          picked === null
            ? null
            : { kind: 'element', file, el: picked, rect: picked.getBoundingClientRect() },
        );
        return;
      }
      const rect = {
        x: Math.min(s0.x, e.clientX),
        y: Math.min(s0.y, e.clientY),
        width: Math.abs(e.clientX - s0.x),
        height: Math.abs(e.clientY - s0.y),
      };
      latest.current.onSelect({ kind: 'area', file, els: elementsInRect(doc, rect), rect });
    });
  };

  const area = selection?.kind === 'area' && selection.file.path === file.path ? selection : null;
  const drawing = selecting ? marquee : null;
  const box = drawing ?? area?.rect ?? null;
  const n = drawing === null ? (area?.els.length ?? 0) : null;
  const size = d.size[file.size];
  const label = fill(file.fidelity === 'wire' ? d.boardNameWire : d.boardName, { screen, size });

  return (
    <div
      className={s['artboard']}
      style={{ left: x, top: y, width }}
      data-artboard={file.path}
      data-moving={moving ? 'true' : undefined}
    >
      <button
        type="button"
        className={s['abLabel']}
        aria-label={label}
        aria-describedby={moveHintId}
        title={label}
        onPointerDown={(e) => onHandlePointerDown(file.path, e)}
        onKeyDown={(e) => onHandleKeyDown(file.path, e)}
        onFocus={(e) => {
          if (e.currentTarget.matches(':focus-visible')) onHandleFocus(file.path);
        }}
        data-board-handle={file.path}
      >
        <b>{screen}</b>
        <span>
          {size}
          {file.fidelity === 'wire' ? ` · ${d.wireframe}` : ''}
        </span>
      </button>
      <div className={s['abFrame']} style={{ width, height }} data-selecting={selecting ? 'true' : undefined}>
        {srcdoc !== null ? (
          <iframe
            ref={frame}
            title={label}
            sandbox="allow-same-origin"
            srcDoc={srcdoc}
            onLoad={onLoad}
            className={s['abIframe']}
            style={{ width, height }}
            tabIndex={-1}
          />
        ) : null}
        {inert ? <div className={s['shield']} data-board-shield="true" /> : null}
        {box !== null ? (
          <div
            className={s['area']}
            style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
            data-area={drawing === null ? 'picked' : 'drawing'}
          >
            {n !== null ? <span className={s['areaTag']}>{areaTag(n, box.width, box.height)}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});

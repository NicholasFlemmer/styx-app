import {
  AGENT_LABEL,
  CANVAS_NUDGE,
  CANVAS_NUDGE_BIG,
  DEFAULT_CANVAS_VIEW,
  DEFAULT_DESIGN_TOKENS,
  DESIGN_SIZES,
  DESIGN_WIDTH,
  canvasToScreen,
  copy,
  defaultLayout,
  fill,
  fitView,
  gridStep,
  layoutFile,
  resolveLayout,
  snapToGrid,
  taskOf,
  tokensCss,
  wheelPan,
  wheelZoomFactor,
  zoomAbout,
  zoomStep,
  type CanvasPoint,
  type CanvasView,
  type DesignFidelity,
  type ResolvedLayout,
  type DesignList,
  type DesignSize,
  type DesignTokens,
  type ProjectId,
  type ReadModel,
  type Session,
  type SessionId,
} from '@styx/core';
import { AgentDot, Button, Select, Textarea } from '@styx/ui';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { command } from '../../state/commands';
import { useModel, useUi } from '../../state/hooks';
import { useUiStore } from '../../state/ui-store';
import { SPAWN_AGENTS } from '../modals/modals';
import { useSpawnForm } from '../modals/use-spawn-form';
import { Artboard, type FrameWheel } from './Artboard';
import { ZOOM_VAR, describeSelection, serializeForSave, type CanvasSelection } from './design-doc';
import { SelectionPanel, TokensPanel, selectionKey } from './DesignInspector';
import { HandoverDialog } from './HandoverDialog';
import s from './DesignCanvas.module.css';

const selectModel = (m: ReadModel) => m;
/** The zoom menu's presets (the current zoom joins them when it is between two). */
const ZOOMS = [0.1, 0.25, 0.33, 0.5, 0.75, 1, 1.5, 2, 4];
const POLL_MS = 2000;
/** A file we just wrote is not reloaded when its own write shows up in the next listing. */
const OWN_WRITE_MS = 3000;
const SAVE_DEBOUNCE_MS = 400;
const NOTICE_MS = 6000;
/** Room above a row for the boards' names when zooming to fit (px on screen). */
const NAME_ROOM = 24;
const EMPTY_HEIGHTS: Record<string, number> = {};

export interface DesignCanvasProps {
  projectId: ProjectId;
  sessionId: SessionId | null;
}

/** The task whose design this lane shows: itself when it is a design task, the design it builds otherwise. */
export const designTaskFor = (model: ReadModel, session: Session | null): Session | null => {
  if (session === null) return null;
  if (session.kind === 'design') return session;
  if (session.designSessionId === undefined) return null;
  return model.sessions.byId[session.designSessionId] ?? null;
};

/**
 * The Design tab (rows 140, 150): a design task's screens (or a build task's own, when its worktree has some) on a
 * freeform canvas (ADR-0030): zoom toward the pointer, pan, and move boards by their names; positions are kept in
 * `.styx/designs/canvas.json`, the zoom and pan per person.
 * Select (V) picks an element or, dragged, an area: change it here, or tell the agent with the element and a picture
 * of it. Aa is Type and colour for every screen. Build it hands the screens over to a build task.
 */
export function DesignCanvas({ projectId, sessionId }: DesignCanvasProps) {
  const model = useModel(selectModel);
  const session = sessionId === null ? null : (model.sessions.byId[sessionId] ?? null);
  const design = designTaskFor(model, session);
  const own = useOwnScreens(session, design === null);
  if (design === null) {
    if (session === null) return <DesignStart projectId={projectId} />;
    // A build task with screens in its own worktree (a mockup put there by hand, or by its agent) shows them.
    if (own === true)
      return <Canvas key={session.id} projectId={projectId} design={session} linked={false} />;
    return own === null ? null : <DesignStart projectId={projectId} />;
  }
  return (
    <Canvas
      key={design.id}
      projectId={projectId}
      design={design}
      linked={session !== null && session.id !== design.id}
    />
  );
}

/**
 * Whether a task's own worktree holds screens (`.styx/designs/<screen>/<size>.html`), polled like the canvas so files
 * dropped in by hand appear without a reload. Null until the first answer, or while not asked.
 */
function useOwnScreens(session: Session | null, enabled: boolean): boolean | null {
  const worktreeId = session?.worktreeId ?? null;
  const [has, setHas] = useState<{ worktreeId: string; screens: boolean } | null>(null);
  useEffect(() => {
    if (!enabled || worktreeId === null) return;
    let live = true;
    const check = async () => {
      const r = await command('design.list', { worktreeId });
      if (live && r.ok) setHas({ worktreeId, screens: r.value.screens.length > 0 });
    };
    const first = setTimeout(() => void check(), 0);
    const t = setInterval(() => void check(), POLL_MS);
    return () => {
      live = false;
      clearTimeout(first);
      clearInterval(t);
    };
  }, [worktreeId, enabled]);
  return enabled && has !== null && has.worktreeId === worktreeId ? has.screens : null;
}

type Notice = { text: string; action?: { label: string; run: () => void } };
type Fidelity = DesignFidelity | 'both';
type Boards = Record<string, CanvasPoint>;

/** The canvas hint with its keys set as keys: `{mod}` and Space. */
const hintParts = (text: string, mod: string) =>
  text
    .split(/(\{mod\}|Space)/)
    .map((part, i) =>
      part === '{mod}' ? <kbd key={i}>{mod}</kbd> : part === 'Space' ? <kbd key={i}>Space</kbd> : part,
    );

const isTyping = (t: EventTarget | null): boolean =>
  t instanceof Element &&
  t.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') !== null;

function Canvas({ projectId, design, linked }: { projectId: ProjectId; design: Session; linked: boolean }) {
  const openSession = useUi((u) => u.openSession);
  const mac = useUi((u) => u.platform) === 'darwin';
  const worktreeId = design.worktreeId;
  const agentName = AGENT_LABEL[design.agent];
  const d = copy.chat.design;
  const [list, setList] = useState<DesignList | null>(null);
  const [fidelity, setFidelity] = useState<Fidelity>('both');
  const [size, setSize] = useState<DesignSize | 'all'>('all');
  const [selecting, setSelecting] = useState(false);
  const [panel, setPanel] = useState<'tokens' | null>(null);
  const [selection, setSelection] = useState<CanvasSelection | null>(null);
  const [draft, setDraft] = useState<DesignTokens | null>(null);
  const [handover, setHandover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [asking, setAsking] = useState(false);
  const [ask, setAsk] = useState('');
  const [versions, setVersions] = useState<Record<string, { mtime: number; version: number }>>({});
  // The freeform canvas (ADR-0030).
  const view = useUi((u) => u.designViews[worktreeId]) ?? DEFAULT_CANVAS_VIEW;
  const [heights, setHeights] = useState<Record<string, number>>(EMPTY_HEIGHTS);
  /** Positions the person (or a placement) set and not yet read back from canvas.json; `rev` counts edits. */
  const [moved, setMoved] = useState<{ boards: Boards; rev: number } | null>(null);
  const [movingPath, setMovingPath] = useState<string | null>(null);
  const [grab, setGrab] = useState(false);
  const [panning, setPanning] = useState(false);
  const undo = useRef<Boards[]>([]);
  const movedRef = useRef<Boards | null>(null);
  const heightsRef = useRef<Record<string, number>>(EMPTY_HEIGHTS);
  const ownWrites = useRef(new Map<string, number>());
  const stage = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tokensTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const askId = useId();
  const moveHintId = useId();
  const dotsId = `dots-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;

  const refresh = useCallback(async () => {
    const r = await command('design.list', { worktreeId });
    if (!r.ok) return;
    const at = Date.now();
    // A file that changed on disk reloads its frame; one we just saved ourselves keeps the frame (and the selection).
    setVersions((prev) => {
      let next = prev;
      for (const screen of r.value.screens)
        for (const f of screen.files) {
          const p = prev[f.path];
          const own = (ownWrites.current.get(f.path) ?? 0) > at - OWN_WRITE_MS;
          if (p !== undefined && p.mtime === f.mtime) continue;
          next = next === prev ? { ...prev } : next;
          next[f.path] = { mtime: f.mtime, version: p === undefined ? 0 : own ? p.version : p.version + 1 };
        }
      return next;
    });
    setList(r.value);
    const source =
      movedRef.current === null ? r.value.layout : { version: 1 as const, boards: movedRef.current };
    if (source === null) return;
    const placed = resolveLayout(r.value.screens, source, heightsRef.current);
    if (placed.placed.length > 0) onPlaced.current(placed, r.value.screens);
  }, [worktreeId]);

  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [refresh]);

  useEffect(
    () => () => {
      for (const t of [saveTimer, editTimer, tokensTimer, noticeTimer])
        if (t.current !== null) clearTimeout(t.current);
    },
    [],
  );

  const tokens = draft ?? list?.tokens ?? null;
  const liveCss = useMemo(() => (draft === null ? null : tokensCss(draft)), [draft]);
  const screens = useMemo(() => list?.screens ?? [], [list]);

  // Where every board sits: what the person moved, else canvas.json, else today's rows; new boards placed beside.
  const savedLayout = list?.layout ?? null;
  const saved = useMemo(
    () => (moved !== null ? { version: 1 as const, boards: moved.boards } : savedLayout),
    [moved, savedLayout],
  );
  const layout = useMemo(() => resolveLayout(screens, saved, heights), [screens, saved, heights]);
  // Handlers read the latest positions through this, so the boards' callbacks stay the same across renders.
  const layoutRef = useRef(layout.boards);
  useEffect(() => {
    layoutRef.current = layout.boards;
    movedRef.current = moved?.boards ?? null;
    heightsRef.current = heights;
  });
  const revRef = useRef(0);

  /** The notice goes after a while, but not while the pointer or focus is on it (its Undo must stay reachable). */
  const holdNotice = useCallback((hold: boolean) => {
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    noticeTimer.current = hold ? null : setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);
  const say = useCallback(
    (n: Notice) => {
      setNotice(n);
      holdNotice(false);
    },
    [holdNotice],
  );
  /** What a keyboard move says to a screen reader (polite; the notice is for things with an action). */
  const [spoken, setSpoken] = useState('');

  const setView = useCallback(
    (next: CanvasView) => useUiStore.getState().setDesignView(worktreeId, next),
    [worktreeId],
  );
  const viewNow = useCallback(
    () => useUiStore.getState().designViews[worktreeId] ?? DEFAULT_CANVAS_VIEW,
    [worktreeId],
  );

  /** Writes the layout once the person stops moving things; reads it back, then lets canvas.json lead again. */
  const save = useCallback(
    (boards: Boards, rev: number) => {
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void command('design.setLayout', { worktreeId, layout: layoutFile(boards) }).then(async (r) => {
          if (!r.ok) return;
          await refresh();
          setMoved((m) => (m !== null && m.rev === rev ? null : m));
        });
      }, SAVE_DEBOUNCE_MS);
    },
    [worktreeId, refresh],
  );

  const commit = useCallback(
    (boards: Boards, opts: { undoable: boolean }) => {
      if (opts.undoable) undo.current.push(layoutRef.current);
      revRef.current += 1;
      setMoved({ boards, rev: revRef.current });
      save(boards, revRef.current);
    },
    [save],
  );

  // Boards the agent added after the layout was saved are placed beside the others and kept there (from `refresh`).
  const onPlaced = useRef<(r: ResolvedLayout, screens: DesignList['screens']) => void>(() => undefined);
  useEffect(() => {
    onPlaced.current = (r, all) => {
      commit(r.boards, { undoable: false });
      const first = r.placed[0];
      const file = all.flatMap((x) => x.files).find((f) => f.path === first);
      const screen = all.find((x) => x.slug === file?.screen);
      if (first === undefined || file === undefined || screen === undefined) return;
      say({
        text: fill(d.added, { agent: agentName, screen: screen.name, size: d.size[file.size] }),
        action: { label: d.showIt, run: () => fitTo([first], 1) },
      });
    };
  });

  const files = useMemo(() => screens.flatMap((x) => x.files), [screens]);
  const shown = useMemo(
    () =>
      files.filter(
        (f) => (fidelity === 'both' || f.fidelity === fidelity) && (size === 'all' || f.size === size),
      ),
    [files, fidelity, size],
  );
  const boxOf = useCallback(
    (path: string) => {
      const f = files.find((x) => x.path === path);
      const p = layout.boards[path];
      if (f === undefined || p === undefined) return null;
      return { x: p.x, y: p.y, w: DESIGN_WIDTH[f.size], h: heights[path] ?? 0 };
    },
    [files, layout.boards, heights],
  );

  const stageSize = () => {
    const el = stage.current;
    return { width: el?.clientWidth ?? 0, height: el?.clientHeight ?? 0 };
  };
  const center = (): CanvasPoint => {
    const z = stageSize();
    return { x: z.width / 2, y: z.height / 2 };
  };
  function fitTo(paths: readonly string[], maxZoom?: number) {
    const boxes = paths.flatMap((p) => boxOf(p) ?? []);
    const next = fitView(boxes, stageSize(), {
      top: NAME_ROOM,
      ...(maxZoom === undefined ? {} : { maxZoom }),
    });
    if (next !== null) setView(next);
  }
  const fitAll = () => fitTo(shown.map((f) => f.path));

  const tidy = () => {
    commit(defaultLayout(screens, heights), { undoable: true });
    say({ text: d.tidied, action: { label: d.undo, run: () => undoLast() } });
    // Fit the rows as they now stand.
    const rows = defaultLayout(screens, heights);
    const boxes = shown.flatMap((f) => {
      const p = rows[f.path];
      return p === undefined ? [] : [{ x: p.x, y: p.y, w: DESIGN_WIDTH[f.size], h: heights[f.path] ?? 0 }];
    });
    const next = fitView(boxes, stageSize(), { top: NAME_ROOM, maxZoom: 1 });
    if (next !== null) setView(next);
  };
  function undoLast() {
    const prev = undo.current.pop();
    if (prev === undefined) return;
    commit(prev, { undoable: false });
  }

  // --- the stage: wheel, pan, move ---
  const onWheel = useCallback(
    (e: FrameWheel) => {
      const v = viewNow();
      if (e.ctrlKey || e.metaKey) {
        const r = stage.current?.getBoundingClientRect();
        const at = { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
        setView(zoomAbout(v, v.zoom * wheelZoomFactor(e.deltaY, e.deltaMode), at));
        return;
      }
      setView(wheelPan(v, { x: e.deltaX, y: e.deltaY, mode: e.deltaMode, shift: e.shiftKey }));
    },
    [setView, viewNow],
  );
  useEffect(() => {
    const el = stage.current;
    if (el === null) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      onWheel({
        clientX: e.clientX,
        clientY: e.clientY,
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaMode: e.deltaMode === 1 ? 1 : e.deltaMode === 2 ? 2 : 0,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
      });
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [onWheel]);

  /** Pans with the pointer until its button comes up (window-wide, so a frame under it cannot take the moves). */
  const startPan = useCallback(
    (clientX: number, clientY: number, clearOnClick: boolean) => {
      const from = { x: clientX, y: clientY, view: viewNow() };
      let movedFar = false;
      setPanning(true);
      const move = (e: PointerEvent) => {
        const dx = e.clientX - from.x;
        const dy = e.clientY - from.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) movedFar = true;
        setView({ zoom: from.view.zoom, x: from.view.x + dx, y: from.view.y + dy });
      };
      const up = () => {
        setPanning(false);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        // A click on empty canvas (no drag) lets go of the selection.
        if (clearOnClick && !movedFar) setSelection(null);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },
    [setView, viewNow],
  );
  const onFramePan = useCallback((x: number, y: number) => startPan(x, y, false), [startPan]);

  const onStagePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const t = e.target instanceof Element ? e.target : null;
    if (t?.closest('[data-board-handle]')) return;
    stage.current?.focus({ preventScroll: true });
    const onBoard = (t?.closest('[data-artboard]') ?? null) !== null;
    if (e.button === 1 || (e.button === 0 && (grab || !onBoard || !selecting))) {
      e.preventDefault();
      startPan(e.clientX, e.clientY, e.button === 0 && !onBoard && !grab);
    }
  };

  const onHandlePointerDown = useCallback(
    (path: string, e: ReactPointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0 || grab) return;
      e.stopPropagation();
      const before = layoutRef.current;
      const start = before[path];
      if (start === undefined) return;
      const from = { x: e.clientX, y: e.clientY, zoom: viewNow().zoom };
      let last = start;
      setMovingPath(path);
      const move = (ev: PointerEvent) => {
        const next = {
          x: snapToGrid(start.x + (ev.clientX - from.x) / from.zoom),
          y: snapToGrid(start.y + (ev.clientY - from.y) / from.zoom),
        };
        if (next.x === last.x && next.y === last.y) return;
        last = next;
        revRef.current += 1;
        setMoved({ boards: { ...before, [path]: next }, rev: revRef.current });
      };
      const up = () => {
        setMovingPath(null);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        if (last === start) return;
        undo.current.push(before);
        commit({ ...before, [path]: last }, { undoable: false });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },
    [grab, commit, viewNow],
  );

  const onHandleKeyDown = useCallback(
    (path: string, e: ReactKeyboardEvent<HTMLButtonElement>) => {
      const dir: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      const step = dir[e.key];
      const boards = layoutRef.current;
      const p = boards[path];
      if (step === undefined || p === undefined || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      const by = e.shiftKey ? CANVAS_NUDGE_BIG : CANVAS_NUDGE;
      const next = { x: snapToGrid(p.x + step[0] * by), y: snapToGrid(p.y + step[1] * by) };
      // A held arrow is one move to undo.
      commit({ ...boards, [path]: next }, { undoable: !e.repeat });
      setSpoken(fill(d.moved, { board: e.currentTarget.getAttribute('aria-label') ?? path, ...next }));
    },
    [commit, d.moved],
  );

  /** A board's name reached by Tab: bring the board into view at the current zoom if it is off the stage. */
  const onHandleFocus = useCallback(
    (path: string) => {
      const p = layoutRef.current[path];
      const el = stage.current;
      if (p === undefined || el === null) return;
      const v = viewNow();
      const at = canvasToScreen(v, p);
      const inside =
        at.x >= 0 && at.y >= NAME_ROOM && at.x < el.clientWidth - 40 && at.y < el.clientHeight - 40;
      if (!inside) setView({ zoom: v.zoom, x: 40 - p.x * v.zoom, y: 40 + NAME_ROOM - p.y * v.zoom });
    },
    [setView, viewNow],
  );

  const onHeight = useCallback((path: string, h: number) => {
    setHeights((prev) => (prev[path] === h ? prev : { ...prev, [path]: h }));
  }, []);

  const onEdited = () => {
    const sel = selection;
    if (sel === null) return;
    const doc = sel.kind === 'element' ? sel.el.ownerDocument : sel.els[0]?.ownerDocument;
    if (!doc) return;
    if (editTimer.current !== null) clearTimeout(editTimer.current);
    editTimer.current = setTimeout(() => {
      ownWrites.current.set(sel.file.path, Date.now());
      void command('design.write', { worktreeId, path: sel.file.path, html: serializeForSave(doc) });
    }, SAVE_DEBOUNCE_MS);
  };

  const onSelect = useCallback((sel: CanvasSelection | null) => {
    setSelection(sel);
    if (sel !== null) setPanel(null);
  }, []);

  const onTokens = (next: DesignTokens) => {
    setDraft(next);
    if (tokensTimer.current !== null) clearTimeout(tokensTimer.current);
    tokensTimer.current = setTimeout(() => {
      void command('design.setTokens', { worktreeId, tokens: next }).then(() => void refresh());
    }, SAVE_DEBOUNCE_MS);
  };

  /** A picture of the selection: its box on screen, from the window's own pixels, cut to the visible canvas. */
  const capture = async (sel: CanvasSelection): Promise<string | null> => {
    const frame = document.querySelector<HTMLIFrameElement>(
      `[data-artboard="${CSS.escape(sel.file.path)}"] iframe`,
    );
    const area = stage.current?.getBoundingClientRect();
    if (frame === null || area === undefined) return null;
    // The frame's rectangle already carries the canvas's pan and zoom; its page is drawn at `k` window px per px.
    const f = frame.getBoundingClientRect();
    const k = frame.offsetWidth > 0 ? f.width / frame.offsetWidth : viewNow().zoom;
    const r = sel.kind === 'element' ? sel.el.getBoundingClientRect() : sel.rect;
    const pad = 8;
    const left = Math.max(area.left, f.left + (r.x - pad) * k, 0);
    const top = Math.max(area.top, f.top + (r.y - pad) * k, 0);
    const right = Math.min(area.right, f.left + (r.x + r.width + pad) * k, window.innerWidth);
    const bottom = Math.min(area.bottom, f.top + (r.y + r.height + pad) * k, window.innerHeight);
    if (right - left < 1 || bottom - top < 1) return null;
    const rect = {
      x: Math.floor(left),
      y: Math.floor(top),
      width: Math.max(1, Math.ceil(right - left)),
      height: Math.max(1, Math.ceil(bottom - top)),
    };
    const res = await command('design.capture', { rect });
    return res.ok ? res.value.image : null;
  };

  const send = async (text: string) => {
    if (selection === null) return;
    setBusy(true);
    const { label, detail } = describeSelection(selection);
    const image = await capture(selection);
    await command('session.sendMessage', {
      sessionId: design.id,
      body: text,
      attachments:
        image === null ? [] : [{ kind: 'image', name: 'selection.png', mediaType: 'image/png', data: image }],
      pointer: { source: 'design', label, detail, toDesign: false },
    });
    setBusy(false);
    say({ text: fill(d.sent, { agent: agentName }) });
  };

  const askForScreen = () => {
    const name = ask.trim();
    if (name === '') return;
    void command('session.sendMessage', {
      sessionId: design.id,
      body: fill(d.askScreenText, { screen: name }),
      attachments: [],
    });
    setAsk('');
    setAsking(false);
  };

  // The canvas's keys while the Design tab is up (not while typing, or under a dialog): V and Escape wherever focus
  // is; zoom with Mod + = - 0; and, with focus on the canvas, Mod+1 (100%), Mod+Z (undo a move) and Space (pan).
  const overlays = useUi((u) => u.overlays.filter((o) => o.kind !== 'toast').length);
  const keys = useRef({ fitAll, undoLast });
  useEffect(() => {
    keys.current = { fitAll, undoLast };
  });
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (overlays > 0 || handover) return;
      const t = e.target instanceof Element ? e.target : null;
      if (isTyping(t)) return;
      const onStage = t !== null && t.closest('[data-design-stage]') !== null;
      const free = onStage || t === null || t === document.body;
      const mod = mac ? e.metaKey : e.ctrlKey;
      if (mod && !e.altKey) {
        const at = center();
        if (e.key === '=' || e.key === '+') setView(zoomStep(viewNow(), 1, at));
        else if (e.key === '-' || e.key === '_') setView(zoomStep(viewNow(), -1, at));
        else if (e.key === '0') keys.current.fitAll();
        else if (e.key === '1' && onStage) setView(zoomAbout(viewNow(), 1, at));
        else if ((e.key === 'z' || e.key === 'Z') && !e.shiftKey && free) keys.current.undoLast();
        else return;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space' && free) {
        e.preventDefault();
        setGrab(true);
      } else if (e.key === 'v' || e.key === 'V') {
        e.preventDefault();
        setSelecting((v) => !v);
      } else if (e.key === 'Escape' && (selection !== null || selecting)) {
        e.preventDefault();
        if (selection !== null) setSelection(null);
        else setSelecting(false);
      }
    };
    const onKeyUp = (e: globalThis.KeyboardEvent) => {
      if (e.code === 'Space') setGrab(false);
    };
    const onBlur = () => setGrab(false);
    // Capture: the app's key registry handles Escape on the way down too; the canvas's selection goes first.
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
    // center/viewNow read refs and the stage; the handler needs re-binding only when these change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlays, handover, selection, selecting, mac, setView, viewNow]);

  // Outlines inside the frames keep their size on screen at any zoom.
  useEffect(() => {
    for (const f of stage.current?.querySelectorAll('iframe') ?? [])
      f.contentDocument?.documentElement.style.setProperty(ZOOM_VAR, String(view.zoom));
  });

  const zoomOptions = useMemo(() => {
    const z = Math.round(view.zoom * 100) / 100;
    return [...new Set([...ZOOMS, z])].sort((a, b) => a - b);
  }, [view.zoom]);
  const pct = `${Math.round(view.zoom * 100)}%`;
  const dot = gridStep(view.zoom);
  const inert = !selecting || grab || panning || movingPath !== null;
  const origin = canvasToScreen(view, { x: 0, y: 0 });

  return (
    <div className={s['root']} data-design-canvas={design.id}>
      <div className={s['bar']} role="toolbar" aria-label={copy.chat.instruments.canvas}>
        <div className={s['seg']} role="radiogroup" aria-label={d.fidelity}>
          {(['wire', 'hi', 'both'] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={fidelity === f}
              data-inv={fidelity === f ? 'true' : undefined}
              onClick={() => setFidelity(f)}
              data-design-fidelity={f}
            >
              {f === 'wire' ? d.wireframe : f === 'hi' ? d.hifi : d.both}
            </button>
          ))}
        </div>
        <div className={s['seg']} role="radiogroup" aria-label={d.sizes}>
          {(['all', ...DESIGN_SIZES] as const).map((z) => (
            <button
              key={z}
              type="button"
              role="radio"
              aria-checked={size === z}
              data-inv={size === z ? 'true' : undefined}
              onClick={() => setSize(z)}
              data-design-size={z}
            >
              {z === 'all' ? d.allSizes : d.size[z]}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={s['tool']}
          aria-pressed={selecting}
          data-on={selecting ? 'true' : undefined}
          title={d.select}
          aria-label={d.select}
          onClick={() => setSelecting((v) => !v)}
          data-design-select="true"
        >
          ↖
        </button>
        <button
          type="button"
          className={s['tool']}
          aria-pressed={panel === 'tokens'}
          data-on={panel === 'tokens' ? 'true' : undefined}
          title={d.typeColour}
          aria-label={d.typeColour}
          onClick={() => {
            setPanel((p) => (p === 'tokens' ? null : 'tokens'));
            setSelection(null);
          }}
          data-design-tokens="true"
        >
          Aa
        </button>
        <span className={s['spacer']} />
        <button
          type="button"
          className={s['tbtn']}
          onClick={fitAll}
          disabled={shown.length === 0}
          title={`${d.zoomFit} (${mac ? '⌘' : 'Ctrl+'}0)`}
          data-design-fit="true"
        >
          {d.zoomFit}
        </button>
        <button
          type="button"
          className={s['tbtn']}
          onClick={tidy}
          disabled={files.length === 0}
          title={d.tidyTitle}
          data-design-tidy="true"
        >
          {d.tidy}
        </button>
        <div className={s['zoomGrp']}>
          <button
            type="button"
            className={s['zstep']}
            aria-label={d.zoomOut}
            title={`${d.zoomOut} (${mac ? '⌘' : 'Ctrl+'}−)`}
            onClick={() => setView(zoomStep(view, -1, center()))}
            data-design-zoom-out="true"
          >
            −
          </button>
          <label className="visually-hidden" htmlFor={`${askId}-zoom`}>
            {d.zoom}
          </label>
          <select
            id={`${askId}-zoom`}
            className={s['zoom']}
            value={String(Math.round(view.zoom * 100) / 100)}
            onChange={(e) => setView(zoomAbout(view, Number(e.currentTarget.value), center()))}
            data-design-zoom={pct}
          >
            {zoomOptions.map((z) => (
              <option key={z} value={String(z)}>
                {Math.round(z * 100)}%
              </option>
            ))}
          </select>
          <button
            type="button"
            className={s['zstep']}
            aria-label={d.zoomIn}
            title={`${d.zoomIn} (${mac ? '⌘' : 'Ctrl+'}+)`}
            onClick={() => setView(zoomStep(view, 1, center()))}
            data-design-zoom-in="true"
          >
            +
          </button>
        </div>
        {/* Build it hands a design task's screens to a build task; a build task showing its own screens is one. */}
        {!linked && design.kind === 'design' ? (
          <Button
            variant="accent"
            size="compact"
            disabled={screens.length === 0}
            onClick={() => setHandover(true)}
            data-design-build="true"
          >
            {d.buildIt} →
          </Button>
        ) : null}
      </div>
      <div className={[s['main'], panel !== null || selection !== null ? s['withPanel'] : ''].join(' ')}>
        <nav className={s['screens']} aria-label={d.screens}>
          {linked ? <p className={s['linked']}>{fill(d.linked, { task: taskOf(design) })}</p> : null}
          <div className={s['screensHead']}>
            <span>{d.screens}</span>
            <span>{screens.length}</span>
          </div>
          {screens.map((screen) => (
            <button
              key={screen.slug}
              type="button"
              className={s['screenItem']}
              onClick={() =>
                fitTo(
                  shown.filter((f) => f.screen === screen.slug).map((f) => f.path),
                  1,
                )
              }
              data-design-screen={screen.slug}
            >
              <span>{screen.name}</span>
              <small>{[...new Set(screen.files.map((f) => d.size[f.size]))].join(' · ')}</small>
            </button>
          ))}
          {asking ? (
            <div className={s['askBox']}>
              <label className="visually-hidden" htmlFor={askId}>
                {d.askScreen}
              </label>
              <input
                id={askId}
                className={s['input']}
                autoFocus
                value={ask}
                placeholder="checkout"
                onChange={(e) => setAsk(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') askForScreen();
                  if (e.key === 'Escape') setAsking(false);
                }}
                data-design-ask-input="true"
              />
            </div>
          ) : (
            <button type="button" className={s['ask']} onClick={() => setAsking(true)} data-design-ask="true">
              {d.askScreen}
            </button>
          )}
          <div className={s['withAgent']}>
            <b>{fill(d.withAgent, { agent: agentName })}</b>
            {fill(d.withAgentBody, { agent: agentName })}
          </div>
        </nav>
        <div
          ref={stage}
          className={s['canvas']}
          role="region"
          aria-label={d.canvas}
          tabIndex={-1}
          data-design-stage="true"
          data-selecting={selecting ? 'true' : undefined}
          data-grab={grab ? 'true' : undefined}
          data-panning={panning ? 'true' : undefined}
          onPointerDown={onStagePointerDown}
          onAuxClick={(e) => e.preventDefault()}
          onScroll={(e) => {
            e.currentTarget.scrollTop = 0;
            e.currentTarget.scrollLeft = 0;
          }}
        >
          <svg className={s['dots']} aria-hidden="true" focusable="false">
            <defs>
              <pattern
                id={dotsId}
                width={dot}
                height={dot}
                x={origin.x - dot / 2}
                y={origin.y - dot / 2}
                patternUnits="userSpaceOnUse"
              >
                <circle className={s['dot']} cx={dot / 2} cy={dot / 2} r={1} />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill={`url(#${dotsId})`} />
          </svg>
          <span id={moveHintId} className="visually-hidden">
            {d.boardMove}
          </span>
          {list !== null && screens.length === 0 ? (
            <div className={s['empty']}>
              <b>{d.noScreens}</b>
              <span>{fill(d.noScreensBody, { agent: agentName })}</span>
            </div>
          ) : list !== null && shown.length === 0 ? (
            <div className={s['empty']}>
              <span>{fill(fidelity === 'wire' ? d.noScreensWire : d.noScreensHi, { agent: agentName })}</span>
            </div>
          ) : (
            <div
              className={s['world']}
              style={
                {
                  transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
                  '--z': view.zoom,
                } as CSSProperties
              }
              data-design-world="true"
            >
              {shown.map((f) => {
                const p = layout.boards[f.path];
                const screen = screens.find((x) => x.slug === f.screen);
                if (p === undefined || screen === undefined) return null;
                return (
                  <Artboard
                    key={f.path}
                    worktreeId={worktreeId}
                    file={f}
                    screen={screen.name}
                    version={versions[f.path]?.version ?? 0}
                    x={p.x}
                    y={p.y}
                    selecting={selecting}
                    inert={inert}
                    moving={movingPath === f.path}
                    moveHintId={moveHintId}
                    liveCss={liveCss}
                    selection={selection}
                    onSelect={onSelect}
                    onHeight={onHeight}
                    onHandlePointerDown={onHandlePointerDown}
                    onHandleKeyDown={onHandleKeyDown}
                    onHandleFocus={onHandleFocus}
                    onFrameWheel={onWheel}
                    onFramePan={onFramePan}
                  />
                );
              })}
            </div>
          )}
          {!selecting && selection === null && screens.length > 0 ? (
            <p className={s['hint']}>{hintParts(d.canvasHint, mac ? '⌘' : 'Ctrl')}</p>
          ) : null}
        </div>
        {selection !== null ? (
          <SelectionPanel
            key={selectionKey(selection)}
            selection={selection}
            tokens={tokens}
            agent={design.agent}
            busy={busy}
            onEdited={onEdited}
            onSend={(text) => void send(text)}
          />
        ) : panel === 'tokens' ? (
          <TokensPanel tokens={tokens} fallback={DEFAULT_DESIGN_TOKENS} onChange={onTokens} />
        ) : null}
      </div>
      <p className="visually-hidden" aria-live="polite">
        {spoken}
      </p>
      {/* Always there, so the first notice is read; shown only while it has something to say. */}
      <div
        className={notice === null ? 'visually-hidden' : s['sent']}
        role="status"
        data-design-notice={notice === null ? undefined : 'true'}
        onMouseEnter={() => holdNotice(true)}
        onMouseLeave={() => holdNotice(false)}
        onFocus={() => holdNotice(true)}
        onBlur={() => holdNotice(false)}
      >
        {notice !== null ? <span>{notice.text}</span> : null}
        {notice?.action !== undefined ? (
          <button
            type="button"
            className={s['noticeBtn']}
            onClick={() => {
              notice.action?.run();
              setNotice(null);
              // The button goes with the notice: focus goes back to the canvas, not to the page.
              stage.current?.focus({ preventScroll: true });
            }}
            data-design-notice-action="true"
          >
            {notice.action.label}
          </button>
        ) : null}
      </div>
      {handover && list !== null ? (
        <HandoverDialog
          designSessionId={design.id}
          agent={design.agent}
          design={list}
          onClose={() => setHandover(false)}
          onStarted={(id, mode) => {
            setHandover(false);
            if (mode === 'new') openSession(projectId, id);
          }}
        />
      ) : null}
    </div>
  );
}

const AGENT_OPTIONS = SPAWN_AGENTS.filter((a) => a !== 'shell').map((a) => ({
  value: a,
  label: copy.agentProducts[a],
}));

/** No design for this lane yet: start a design task (its own lane, its own branch). */
function DesignStart({ projectId }: { projectId: ProjectId }) {
  const openSession = useUi((u) => u.openSession);
  const { form, pickAgent, valid, busy, spawn } = useSpawnForm(projectId);
  const [text, setText] = useState('');
  const ids = { text: useId(), agent: useId() };
  const t = copy.chat.design.start;
  const ready = valid && text.trim() !== '';
  const start = async () => {
    if (!ready) return;
    const id = await spawn(text.trim(), 'design');
    if (id !== null) openSession(projectId, id);
  };
  return (
    <div className={s['start']} data-design-start="true">
      <div className={s['startIn']}>
        <h2 className={s['startTitle']}>{t.title}</h2>
        <p className={s['startBody']}>{t.body}</p>
        <label htmlFor={ids.text} className="visually-hidden">
          {t.label}
        </label>
        <Textarea
          id={ids.text}
          minHeight={84}
          placeholder={t.placeholder}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void start();
            }
          }}
          data-design-start-text="true"
        />
        <div className={s['startRow']}>
          <label htmlFor={ids.agent} className="visually-hidden">
            {copy.chat.design.handover.agent}
          </label>
          <AgentDot agent={form.agent} />
          <Select
            id={ids.agent}
            value={form.agent}
            options={AGENT_OPTIONS}
            onChange={(e) => {
              const a = SPAWN_AGENTS.find((x) => x === e.currentTarget.value);
              if (a !== undefined) pickAgent(a);
            }}
          />
          <Button
            variant="accent"
            disabled={!ready || busy}
            onClick={() => void start()}
            className={s['startBtn'] ?? ''}
            data-design-start-go="true"
          >
            {t.start}
          </Button>
        </div>
      </div>
    </div>
  );
}

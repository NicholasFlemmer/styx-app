import {
  DESIGN_SIZES,
  DESIGN_WIDTH,
  type CanvasPoint,
  type DesignCanvasFile,
  type DesignFile,
  type DesignScreen,
  type DesignSize,
} from '../model/design';

/**
 * The Design tab's freeform canvas (ADR-0030): pure geometry for the stage the boards sit on. Canvas coordinates are
 * pixels at 100%; the view maps them to the screen as `screen = canvas × zoom + pan`.
 */

/** Board positions snap to this grid (canvas px); arrow keys move a board by one step, Shift by five. */
export const CANVAS_GRID = 8;
export const CANVAS_NUDGE = CANVAS_GRID;
export const CANVAS_NUDGE_BIG = CANVAS_GRID * 5;
/** Space between boards in a row, and between rows (canvas px). */
export const CANVAS_GAP = 80;
export const CANVAS_ROW_GAP = 160;
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 4;
/** Where ⌘+ / ⌘− stop. */
export const ZOOM_STEPS: readonly number[] = [0.1, 0.15, 0.25, 0.33, 0.5, 0.75, 1, 1.5, 2, 3, 4];
/** A board's height before its frame has measured its page: a common viewport for the size. */
export const DESIGN_HEIGHT: Record<DesignSize, number> = { desktop: 800, tablet: 1112, phone: 844 };

export interface CanvasView {
  zoom: number;
  /** Where the canvas origin sits on screen, relative to the stage's top-left (px). */
  x: number;
  y: number;
}

/** First open: today's 33%, the rows starting just inside the stage's corner, room above for the first names. */
export const DEFAULT_CANVAS_VIEW: CanvasView = { zoom: 0.33, x: 24, y: 40 };

export interface CanvasBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CanvasSize {
  width: number;
  height: number;
}

export const snapToGrid = (v: number): number => Math.round(v / CANVAS_GRID) * CANVAS_GRID || 0;

/** Up to the next grid line: a placement never rounds back into the board it is clearing. */
const ceilToGrid = (v: number): number => Math.ceil(v / CANVAS_GRID) * CANVAS_GRID;

export const clampZoom = (z: number): number =>
  Number.isFinite(z) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) : ZOOM_MIN;

/** A point on the stage (px from its top-left) as a canvas point. */
export const screenToCanvas = (view: CanvasView, p: CanvasPoint): CanvasPoint => ({
  x: (p.x - view.x) / view.zoom,
  y: (p.y - view.y) / view.zoom,
});

/** A canvas point as a point on the stage. */
export const canvasToScreen = (view: CanvasView, p: CanvasPoint): CanvasPoint => ({
  x: p.x * view.zoom + view.x,
  y: p.y * view.zoom + view.y,
});

/** Zoom to `zoom` (clamped) keeping the canvas point under `at` (a stage point) where it is. */
export const zoomAbout = (view: CanvasView, zoom: number, at: CanvasPoint): CanvasView => {
  const z = clampZoom(zoom);
  const c = screenToCanvas(view, at);
  return { zoom: z, x: at.x - c.x * z, y: at.y - c.y * z };
};

/** ⌘+ / ⌘−: the next step up or down from the current zoom, about `at`. */
export const zoomStep = (view: CanvasView, dir: 1 | -1, at: CanvasPoint): CanvasView => {
  const eps = 1e-3;
  const next =
    dir > 0
      ? (ZOOM_STEPS.find((s) => s > view.zoom + eps) ?? ZOOM_MAX)
      : ([...ZOOM_STEPS].reverse().find((s) => s < view.zoom - eps) ?? ZOOM_MIN);
  return zoomAbout(view, next, at);
};

/**
 * How much one wheel event zooms. A trackpad pinch arrives as small fractional deltas (with ctrlKey); a mouse wheel
 * notch as about 100 px (or 3 lines): pinches follow the fingers, notches step by 20%.
 */
export const wheelZoomFactor = (deltaY: number, deltaMode: 0 | 1 | 2): number => {
  const px = deltaY * (deltaMode === 1 ? 33 : deltaMode === 2 ? 600 : 1);
  if (px === 0) return 1;
  if (Math.abs(px) < 40) return Math.exp(-px * 0.012);
  return px > 0 ? 1 / 1.2 : 1.2;
};

/** Pan by a wheel event: Shift turns a vertical wheel sideways (a mouse with one wheel). */
export const wheelPan = (
  view: CanvasView,
  delta: { x: number; y: number; mode: 0 | 1 | 2; shift: boolean },
): CanvasView => {
  const k = delta.mode === 1 ? 33 : delta.mode === 2 ? 600 : 1;
  let dx = delta.x * k;
  let dy = delta.y * k;
  if (delta.shift && dx === 0) {
    dx = dy;
    dy = 0;
  }
  return { zoom: view.zoom, x: view.x - dx, y: view.y - dy };
};

/** The smallest box around `boxes`, or null for none. */
export const boundsOf = (boxes: readonly CanvasBox[]): CanvasBox | null => {
  if (boxes.length === 0) return null;
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

/**
 * Zoom to fit: every box in the stage with `pad` px around, `top` px more above (the boards' names), centred, never
 * past `maxZoom`. Null when there is nothing to fit or no room to fit it in.
 */
export const fitView = (
  boxes: readonly CanvasBox[],
  stage: CanvasSize,
  opts: { pad?: number; top?: number; maxZoom?: number } = {},
): CanvasView | null => {
  const b = boundsOf(boxes);
  const pad = opts.pad ?? 40;
  const top = opts.top ?? 24;
  const w = stage.width - pad * 2;
  const h = stage.height - pad * 2 - top;
  if (b === null || w <= 0 || h <= 0) return null;
  const zoom = clampZoom(Math.min(w / Math.max(1, b.w), h / Math.max(1, b.h), opts.maxZoom ?? ZOOM_MAX));
  return {
    zoom,
    x: pad + (w - b.w * zoom) / 2 - b.x * zoom,
    y: pad + top + (h - b.h * zoom) / 2 - b.y * zoom,
  };
};

/** The dot grid's spacing on screen: canvas grid steps, doubled until the dots are at least `min` px apart. */
export const gridStep = (zoom: number, min = 14): number => {
  let step = CANVAS_GRID;
  while (step * zoom < min) step *= 2;
  return step * zoom;
};

/** A board on the canvas: one screen file, where it sits and how big it is. */
export interface CanvasBoard extends CanvasBox {
  path: string;
  screen: string;
}

const boardOrder = (f: Pick<DesignFile, 'size' | 'fidelity'>): number =>
  DESIGN_SIZES.indexOf(f.size) * 2 + (f.fidelity === 'wire' ? 0 : 1);

const boxOf = (f: DesignFile, heights: Readonly<Record<string, number>>) => ({
  w: DESIGN_WIDTH[f.size],
  h: heights[f.path] ?? DESIGN_HEIGHT[f.size],
});

/**
 * Today's rows (the first open, and Tidy up): one row per screen in the list's order; in a row desktop, tablet,
 * phone, a wireframe before its hi-fi; each row below the tallest board of the one above.
 */
export const defaultLayout = (
  screens: readonly DesignScreen[],
  heights: Readonly<Record<string, number>> = {},
): Record<string, CanvasPoint> => {
  const out: Record<string, CanvasPoint> = {};
  let y = 0;
  for (const screen of screens) {
    const row = [...screen.files].sort((a, b) => boardOrder(a) - boardOrder(b));
    if (row.length === 0) continue;
    let x = 0;
    let tallest = 0;
    for (const f of row) {
      const { w, h } = boxOf(f, heights);
      out[f.path] = { x, y };
      x = snapToGrid(x + w + CANVAS_GAP);
      tallest = Math.max(tallest, h);
    }
    y = snapToGrid(y + tallest + CANVAS_ROW_GAP);
  }
  return out;
};

const overlaps = (a: CanvasBox, b: CanvasBox, gap: number): boolean =>
  a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;

/**
 * Where a new board goes so it overlaps nothing: right of its screen's rightmost board (a new size or fidelity), or
 * starting a row under the lowest board at the left edge (a new screen); then right, past whatever it would touch.
 */
export const placeBoard = (
  board: { screen: string; w: number; h: number },
  others: readonly CanvasBoard[],
): CanvasPoint => {
  const mine = others.filter((o) => o.screen === board.screen);
  let x = 0;
  let y = 0;
  if (mine.length > 0) {
    const right = mine.reduce((a, o) => (o.x + o.w > a.x + a.w ? o : a));
    x = ceilToGrid(right.x + right.w + CANVAS_GAP);
    y = right.y;
  } else if (others.length > 0) {
    x = Math.min(...others.map((o) => o.x));
    y = ceilToGrid(Math.max(...others.map((o) => o.y + o.h)) + CANVAS_ROW_GAP);
  }
  for (;;) {
    const box = { x, y, w: board.w, h: board.h };
    const hit = others.filter((o) => overlaps(box, o, CANVAS_GAP));
    if (hit.length === 0) return { x, y };
    x = ceilToGrid(Math.max(...hit.map((o) => o.x + o.w)) + CANVAS_GAP);
  }
};

export interface ResolvedLayout {
  /** Every screen file's position. */
  boards: Record<string, CanvasPoint>;
  /** Files that had no saved position and were just placed (empty with no saved layout: the rows hold everything). */
  placed: string[];
}

/**
 * The canvas as it opens: today's rows until a layout is saved; after that the saved positions, with any board the
 * agent added since placed beside the others without overlapping. Saved entries for files that are gone are dropped.
 */
export const resolveLayout = (
  screens: readonly DesignScreen[],
  saved: DesignCanvasFile | null,
  heights: Readonly<Record<string, number>> = {},
): ResolvedLayout => {
  if (saved === null) return { boards: defaultLayout(screens, heights), placed: [] };
  const boards: Record<string, CanvasPoint> = {};
  const placedBoards: CanvasBoard[] = [];
  const missing: DesignFile[] = [];
  for (const screen of screens)
    for (const f of [...screen.files].sort((a, b) => boardOrder(a) - boardOrder(b))) {
      const p = saved.boards[f.path];
      if (p === undefined) {
        missing.push(f);
        continue;
      }
      boards[f.path] = { x: p.x, y: p.y };
      placedBoards.push({ path: f.path, screen: f.screen, x: p.x, y: p.y, ...boxOf(f, heights) });
    }
  for (const f of missing) {
    const size = boxOf(f, heights);
    const p = placeBoard({ screen: f.screen, ...size }, placedBoards);
    boards[f.path] = p;
    placedBoards.push({ path: f.path, screen: f.screen, ...p, ...size });
  }
  return { boards, placed: missing.map((f) => f.path) };
};

/** Positions as the file stores them: whole canvas px on the grid. */
export const layoutFile = (boards: Readonly<Record<string, CanvasPoint>>): DesignCanvasFile => {
  const out: Record<string, CanvasPoint> = {};
  for (const [path, p] of Object.entries(boards)) out[path] = { x: snapToGrid(p.x), y: snapToGrid(p.y) };
  return { version: 1, boards: out };
};

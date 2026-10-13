import { describe, expect, it } from 'vitest';
import { designScreens, type DesignFile } from '../model/design';
import {
  CANVAS_GAP,
  CANVAS_ROW_GAP,
  DEFAULT_CANVAS_VIEW,
  DESIGN_HEIGHT,
  ZOOM_MAX,
  ZOOM_MIN,
  boundsOf,
  canvasToScreen,
  clampZoom,
  defaultLayout,
  fitView,
  gridStep,
  layoutFile,
  placeBoard,
  resolveLayout,
  screenToCanvas,
  snapToGrid,
  wheelPan,
  wheelZoomFactor,
  zoomAbout,
  zoomStep,
  type CanvasBoard,
  type CanvasView,
} from './design-canvas';

const file = (path: string): DesignFile => {
  const [screen = '', rest = ''] = path.split('/');
  const size = rest.split('.')[0] as DesignFile['size'];
  return { path, screen, size, fidelity: rest.includes('.wire') ? 'wire' : 'hi', mtime: 1 };
};
const screens = (...paths: string[]) => designScreens(paths.map(file));

describe('snapToGrid', () => {
  it.each([
    [0, 0],
    [3, 0],
    [4, 8],
    [12, 16],
    [-3, 0],
    [-5, -8],
    [1361, 1360],
  ])('%d → %d', (v, out) => {
    expect(Object.is(snapToGrid(v), out)).toBe(true);
  });
});

describe('clampZoom', () => {
  it.each([
    [0.05, ZOOM_MIN],
    [0.1, 0.1],
    [1, 1],
    [4, 4],
    [9, ZOOM_MAX],
    [Number.NaN, ZOOM_MIN],
    [Number.POSITIVE_INFINITY, ZOOM_MIN],
  ])('%d → %d', (z, out) => {
    expect(clampZoom(z)).toBe(out);
  });
});

describe('screen ↔ canvas', () => {
  const views: CanvasView[] = [
    { zoom: 1, x: 0, y: 0 },
    { zoom: 0.33, x: 24, y: 40 },
    { zoom: 2.5, x: -300, y: 120 },
  ];
  it.each(views)('round-trips at %o', (view) => {
    const p = { x: 137, y: -42 };
    const back = screenToCanvas(view, canvasToScreen(view, p));
    expect(back.x).toBeCloseTo(p.x);
    expect(back.y).toBeCloseTo(p.y);
  });
  it('maps the origin to the pan and scales by the zoom', () => {
    expect(canvasToScreen({ zoom: 0.5, x: 10, y: 20 }, { x: 0, y: 0 })).toEqual({ x: 10, y: 20 });
    expect(canvasToScreen({ zoom: 0.5, x: 10, y: 20 }, { x: 100, y: 40 })).toEqual({ x: 60, y: 40 });
    expect(screenToCanvas({ zoom: 0.5, x: 10, y: 20 }, { x: 60, y: 40 })).toEqual({ x: 100, y: 40 });
  });
});

describe('zoomAbout', () => {
  it.each([
    [1.2, { x: 300, y: 200 }],
    [3, { x: 0, y: 0 }],
    [0.12, { x: 512, y: 640 }],
  ])('keeps the point under the pointer still (to %d)', (z, at) => {
    const view = DEFAULT_CANVAS_VIEW;
    const before = screenToCanvas(view, at);
    const next = zoomAbout(view, z, at);
    expect(next.zoom).toBe(z);
    const after = screenToCanvas(next, at);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });
  it.each([
    [0.01, ZOOM_MIN],
    [40, ZOOM_MAX],
  ])('clamps %d to %d', (z, out) => {
    expect(zoomAbout(DEFAULT_CANVAS_VIEW, z, { x: 10, y: 10 }).zoom).toBe(out);
  });
});

describe('zoomStep', () => {
  const at = { x: 0, y: 0 };
  it.each([
    [0.33, 1, 0.5],
    [0.33, -1, 0.25],
    [0.4, 1, 0.5],
    [0.4, -1, 0.33],
    [4, 1, 4],
    [0.1, -1, 0.1],
    [3.5, 1, 4],
    [0.12, -1, 0.1],
  ] as const)('from %d by %d → %d', (zoom, dir, out) => {
    expect(zoomStep({ zoom, x: 0, y: 0 }, dir, at).zoom).toBe(out);
  });
});

describe('wheelZoomFactor', () => {
  it.each([
    [0, 0, 1],
    [-100, 0, 1.2],
    [100, 0, 1 / 1.2],
    [-3, 1, 1.2],
    [1, 2, 1 / 1.2],
  ] as const)('a notch (%d, mode %d) steps by 20%%', (d, mode, out) => {
    expect(wheelZoomFactor(d, mode)).toBeCloseTo(out);
  });
  it('a pinch follows the fingers: small deltas, small changes, in, out and symmetric', () => {
    const inn = wheelZoomFactor(-5, 0);
    const out = wheelZoomFactor(5, 0);
    expect(inn).toBeGreaterThan(1);
    expect(inn).toBeLessThan(1.1);
    expect(out).toBeLessThan(1);
    expect(inn * out).toBeCloseTo(1);
  });
});

describe('wheelPan', () => {
  const view = { zoom: 0.5, x: 100, y: 100 };
  it.each([
    [
      { x: 0, y: 30, mode: 0, shift: false },
      { x: 100, y: 70 },
    ],
    [
      { x: 20, y: 0, mode: 0, shift: false },
      { x: 80, y: 100 },
    ],
    [
      { x: 0, y: 30, mode: 0, shift: true },
      { x: 70, y: 100 },
    ],
    [
      { x: 10, y: 30, mode: 0, shift: true },
      { x: 90, y: 70 },
    ],
    [
      { x: 0, y: 1, mode: 1, shift: false },
      { x: 100, y: 67 },
    ],
    [
      { x: 0, y: 1, mode: 2, shift: false },
      { x: 100, y: -500 },
    ],
  ] as const)('%o moves the canvas the other way', (delta, out) => {
    expect(wheelPan(view, delta)).toEqual({ zoom: 0.5, ...out });
  });
});

describe('boundsOf / fitView', () => {
  const boxes = [
    { x: 0, y: 0, w: 1280, h: 800 },
    { x: 1360, y: 0, w: 390, h: 844 },
    { x: 0, y: 1008, w: 1280, h: 720 },
  ];
  it('bounds every box; none is null', () => {
    expect(boundsOf(boxes)).toEqual({ x: 0, y: 0, w: 1750, h: 1728 });
    expect(boundsOf([])).toBeNull();
  });
  it('fits everything inside the stage, centred, with room for names', () => {
    const stage = { width: 900, height: 700 };
    const v = fitView(boxes, stage);
    if (v === null) throw new Error('no fit');
    const tl = canvasToScreen(v, { x: 0, y: 0 });
    const br = canvasToScreen(v, { x: 1750, y: 1728 });
    expect(tl.x).toBeGreaterThanOrEqual(40 - 1e-6);
    expect(tl.y).toBeGreaterThanOrEqual(64 - 1e-6);
    expect(br.x).toBeLessThanOrEqual(860 + 1e-6);
    expect(br.y).toBeLessThanOrEqual(660 + 1e-6);
    // Centred on the long side's spare room.
    expect(tl.x - 40).toBeCloseTo(860 - br.x);
  });
  it('never zooms past maxZoom (a small screen is not blown up), and clamps to the range', () => {
    expect(fitView([{ x: 0, y: 0, w: 100, h: 100 }], { width: 900, height: 700 }, { maxZoom: 1 })?.zoom).toBe(
      1,
    );
    expect(fitView([{ x: 0, y: 0, w: 10, h: 10 }], { width: 900, height: 700 })?.zoom).toBe(ZOOM_MAX);
    expect(fitView([{ x: 0, y: 0, w: 1e7, h: 1e7 }], { width: 900, height: 700 })?.zoom).toBe(ZOOM_MIN);
    expect(fitView([{ x: 5, y: 5, w: 0, h: 0 }], { width: 900, height: 700 }, { pad: 0, top: 0 })).toEqual({
      zoom: ZOOM_MAX,
      x: 450 - 20,
      y: 350 - 20,
    });
  });
  it('nothing to fit, or no room, is null', () => {
    expect(fitView([], { width: 900, height: 700 })).toBeNull();
    expect(fitView(boxes, { width: 60, height: 700 })).toBeNull();
    expect(fitView(boxes, { width: 900, height: 90 })).toBeNull();
  });
});

describe('gridStep', () => {
  it.each([
    [1, 16],
    [2, 16],
    [0.33, 32 * 0.33 * 2],
    [4, 32],
    [0.1, 128 * 0.1 * 2],
  ])('at %d the dots are %d px apart', (z, out) => {
    expect(gridStep(z)).toBeCloseTo(out);
  });
});

describe('defaultLayout (today’s rows)', () => {
  it('one row per screen, desktop → tablet → phone, wireframe before hi-fi', () => {
    const s = screens(
      'home/desktop.html',
      'checkout/phone.html',
      'checkout/desktop.html',
      'checkout/desktop.wire.html',
      'home/desktop.wire.html',
      'settings/desktop.html',
    );
    expect(defaultLayout(s)).toEqual({
      'checkout/desktop.wire.html': { x: 0, y: 0 },
      'checkout/desktop.html': { x: 1280 + CANVAS_GAP, y: 0 },
      'checkout/phone.html': { x: 2 * (1280 + CANVAS_GAP), y: 0 },
      'home/desktop.wire.html': { x: 0, y: 1008 },
      'home/desktop.html': { x: 1360, y: 1008 },
      'settings/desktop.html': { x: 0, y: 1008 + 800 + CANVAS_ROW_GAP },
    });
  });
  it('a row sits under the tallest measured board above it; widths follow the size', () => {
    const s = screens('a/desktop.html', 'a/tablet.html', 'b/phone.html');
    expect(defaultLayout(s, { 'a/desktop.html': 2400 })).toEqual({
      'a/desktop.html': { x: 0, y: 0 },
      'a/tablet.html': { x: 1360, y: 0 },
      'b/phone.html': { x: 0, y: 2560 },
    });
    // Unmeasured: the size's usual height.
    expect(defaultLayout(s)['b/phone.html']).toEqual({ x: 0, y: DESIGN_HEIGHT.tablet + CANVAS_ROW_GAP });
  });
  it('a screen with no files takes no row', () => {
    expect(defaultLayout([{ slug: 'x', name: 'X', files: [] }, ...screens('y/phone.html')])).toEqual({
      'y/phone.html': { x: 0, y: 0 },
    });
    expect(defaultLayout([])).toEqual({});
  });
});

describe('placeBoard', () => {
  const b = (path: string, x: number, y: number, w = 1280, h = 800): CanvasBoard => ({
    path,
    screen: path.split('/')[0] ?? '',
    x,
    y,
    w,
    h,
  });
  it('the first board on an empty canvas goes to the origin', () => {
    expect(placeBoard({ screen: 'a', w: 390, h: 844 }, [])).toEqual({ x: 0, y: 0 });
  });
  it('a new size of a screen goes right of its rightmost board, level with it', () => {
    const others = [b('checkout/desktop.html', 0, 0), b('checkout/tablet.html', 1360, 0, 834, 1112)];
    expect(placeBoard({ screen: 'checkout', w: 390, h: 844 }, others)).toEqual({ x: 2280, y: 0 });
  });
  it('whatever order the boards come in, it is the rightmost one it goes beside', () => {
    const others = [b('checkout/tablet.html', 1360, 0, 834, 1112), b('checkout/desktop.html', 0, 0)];
    expect(placeBoard({ screen: 'checkout', w: 390, h: 844 }, others)).toEqual({ x: 2280, y: 0 });
  });
  it('a new screen starts a row under the lowest board, at the left edge', () => {
    const others = [b('a/desktop.html', 200, 0), b('b/desktop.html', 400, 1000, 1280, 900)];
    expect(placeBoard({ screen: 'c', w: 1280, h: 800 }, others)).toEqual({ x: 200, y: 2064 });
  });
  it('steps right past anything it would overlap (gap included)', () => {
    const others = [
      b('a/desktop.html', 0, 0),
      // Someone dragged a board where a's next size would go.
      b('z/phone.html', 1400, 100, 390, 844),
    ];
    const p = placeBoard({ screen: 'a', w: 390, h: 844 }, others);
    expect(p).toEqual({ x: snapToGrid(1400 + 390 + CANVAS_GAP), y: 0 });
    const placed = { ...p, w: 390, h: 844 };
    for (const o of others)
      expect(placed.x >= o.x + o.w || placed.x + placed.w <= o.x || placed.y >= o.y + o.h).toBe(true);
  });
});

describe('resolveLayout', () => {
  const s = screens('checkout/desktop.html', 'checkout/phone.html', 'home/desktop.html');
  it('with nothing saved: today’s rows, nothing "placed"', () => {
    expect(resolveLayout(s, null)).toEqual({ boards: defaultLayout(s), placed: [] });
  });
  it('saved positions win; a board added since is placed beside, without overlapping; gone files drop out', () => {
    const saved = {
      version: 1 as const,
      boards: {
        'checkout/desktop.html': { x: 0, y: 0 },
        'home/desktop.html': { x: 1360, y: 0 },
        'gone/desktop.html': { x: 9000, y: 9000 },
      },
    };
    const r = resolveLayout(s, saved);
    expect(r.placed).toEqual(['checkout/phone.html']);
    expect(r.boards['checkout/desktop.html']).toEqual({ x: 0, y: 0 });
    expect(r.boards['home/desktop.html']).toEqual({ x: 1360, y: 0 });
    // Right of checkout's desktop would hit home: it steps past it.
    expect(r.boards['checkout/phone.html']).toEqual({ x: 1360 + 1280 + CANVAS_GAP, y: 0 });
    expect(r.boards['gone/desktop.html']).toBeUndefined();
  });
  it('two new boards are placed one after the other, never on each other', () => {
    const r = resolveLayout(s, { version: 1, boards: {} });
    expect(r.placed).toEqual(['checkout/desktop.html', 'checkout/phone.html', 'home/desktop.html']);
    expect(r.boards).toEqual({
      'checkout/desktop.html': { x: 0, y: 0 },
      'checkout/phone.html': { x: 1360, y: 0 },
      'home/desktop.html': { x: 0, y: 1008 },
    });
  });
});

describe('layoutFile', () => {
  it('snaps positions to the grid and versions the file', () => {
    expect(layoutFile({ 'a/desktop.html': { x: 13, y: -3.4 } })).toEqual({
      version: 1,
      boards: { 'a/desktop.html': { x: 16, y: 0 } },
    });
  });
});

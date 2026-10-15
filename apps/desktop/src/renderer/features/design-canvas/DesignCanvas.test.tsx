// @vitest-environment jsdom
import { DEFAULT_CANVAS_VIEW, copy, fill, fixtures, type DesignList } from '@styx/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { DesignCanvas } from './DesignCanvas';

const { ids } = fixtures;
const acme = ids.project.acmeShop;
/** The demo's Claude lane: a build task with no linked design. */
const build = ids.session.claude;
const d = copy.chat.design;

const listWith =
  (screens: DesignList['screens'], layout: DesignList['layout'] = null) =>
  (worktreeId: string) =>
    ({ worktreeId, screens, tokens: null, layout }) satisfies DesignList;

const file = (path: string) => {
  const [screen = '', rest = ''] = path.split('/');
  return {
    path,
    screen,
    size: rest.split('.')[0] as 'desktop' | 'tablet' | 'phone',
    fidelity: rest.includes('.wire') ? ('wire' as const) : ('hi' as const),
    mtime: 1,
  };
};

const DOCS: DesignList['screens'] = [{ slug: 'docs', name: 'Docs', files: [file('docs/desktop.html')] }];
const CHECKOUT: DesignList['screens'] = [
  {
    slug: 'checkout',
    name: 'Checkout',
    files: [file('checkout/desktop.html'), file('checkout/desktop.wire.html'), file('checkout/phone.html')],
  },
];

let calls: { name: string; input: unknown }[] = [];
const mount = (list: (worktreeId: string) => DesignList) => {
  calls = [];
  Object.assign(window, {
    styx: {
      platform: 'darwin',
      env: { now: fixtures.DEMO_NOW },
      command: vi.fn(async (name: string, input: { worktreeId?: string }) => {
        calls.push({ name, input });
        if (name === 'design.list') return { ok: true, value: list(input.worktreeId ?? '') };
        if (name === 'design.read') return { ok: true, value: { html: '<p>docs</p>', css: '' } };
        return { ok: true, value: {} };
      }),
    },
  });
  return render(<DesignCanvas projectId={acme} sessionId={build} />);
};

const worktreeId = () => fixtures.demoReadModel().sessions.byId[build]?.worktreeId ?? '';
const viewNow = () => useUiStore.getState().designViews[worktreeId()] ?? DEFAULT_CANVAS_VIEW;
const stage = () => screen.getByRole('region', { name: d.canvas });
const boardAt = (path: string) => {
  const el = document.querySelector<HTMLElement>(`[data-artboard="${path}"]`);
  if (el === null) throw new Error(`no board ${path}`);
  return { left: Number.parseFloat(el.style.left), top: Number.parseFloat(el.style.top) };
};
const setLayouts = () => calls.filter((c) => c.name === 'design.setLayout');

describe('DesignCanvas: a build task with its own screens (#150)', () => {
  beforeEach(() => {
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({ overlays: [], platform: 'darwin', designViews: {} });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('shows the screens in its own worktree, without Build it (it is the build)', async () => {
    mount(listWith(DOCS));
    const nav = await screen.findByRole('navigation', { name: d.screens });
    await waitFor(() => expect(nav.textContent).toContain('Docs'));
    expect(document.querySelector('[data-design-build]')).toBeNull();
    expect(document.querySelector('[data-design-start]')).toBeNull();
  });

  it('with no screens of its own, offers to start a design as before', async () => {
    mount(listWith([]));
    await waitFor(() => expect(document.querySelector('[data-design-start]')).not.toBeNull());
    expect(screen.queryByRole('navigation', { name: d.screens })).toBeNull();
  });
});

describe('DesignCanvas: the freeform canvas (ADR-0030)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({ overlays: [], platform: 'darwin', designViews: {} });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Object.assign(window, { styx: undefined });
  });

  const ready = async (layout: DesignList['layout'] = null) => {
    mount(listWith(CHECKOUT, layout));
    await waitFor(() => expect(document.querySelectorAll('[data-artboard]').length).toBe(3));
    // And every screen has been read into its frame, as the person sees it: on a busy machine (Styx's checks before a
    // land run every suite at once) the reads land after the boards, and a move made before them was lost.
    await waitFor(() => expect(calls.filter((c) => c.name === 'design.read').length).toBeGreaterThanOrEqual(3));
  };

  it('opens in today’s rows at 33%, both fidelities shown, wireframe first', async () => {
    await ready();
    expect(screen.getByRole('radio', { name: d.both }).getAttribute('aria-checked')).toBe('true');
    expect(boardAt('checkout/desktop.wire.html')).toEqual({ left: 0, top: 0 });
    expect(boardAt('checkout/desktop.html')).toEqual({ left: 1360, top: 0 });
    expect(boardAt('checkout/phone.html')).toEqual({ left: 2720, top: 0 });
    expect((screen.getByLabelText(d.zoom, { selector: 'select' }) as HTMLSelectElement).value).toBe('0.33');
  });

  it('a filter hides boards in place: nothing moves', async () => {
    await ready();
    fireEvent.click(screen.getByRole('radio', { name: d.hifi }));
    expect(document.querySelector('[data-artboard="checkout/desktop.wire.html"]')).toBeNull();
    expect(boardAt('checkout/desktop.html')).toEqual({ left: 1360, top: 0 });
  });

  it('Ctrl / ⌘ + wheel zooms toward the pointer; the zoom control follows; a plain wheel pans', async () => {
    await ready();
    fireEvent.wheel(stage(), { deltaY: -100, ctrlKey: true, clientX: 100, clientY: 100 });
    expect(viewNow().zoom).toBeCloseTo(0.33 * 1.2);
    // The canvas point under the pointer stayed put.
    expect((100 - viewNow().x) / viewNow().zoom).toBeCloseTo((100 - 24) / 0.33);
    expect(screen.getByRole('option', { name: '40%' })).toBeTruthy();
    const before = viewNow();
    fireEvent.wheel(stage(), { deltaY: 50 });
    expect(viewNow()).toEqual({ ...before, y: before.y - 50 });
    fireEvent.wheel(stage(), { deltaY: 30, shiftKey: true });
    expect(viewNow().x).toBe(before.x - 30);
  });

  it('⌘+ / ⌘− step the zoom; ⌘1 is 100% with focus on the canvas', async () => {
    await ready();
    fireEvent.keyDown(document.body, { key: '=', metaKey: true });
    expect(viewNow().zoom).toBe(0.5);
    fireEvent.keyDown(document.body, { key: '-', metaKey: true });
    expect(viewNow().zoom).toBe(0.33);
    stage().focus();
    fireEvent.keyDown(stage(), { key: '1', metaKey: true });
    expect(viewNow().zoom).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: d.zoomOut }));
    expect(viewNow().zoom).toBe(0.75);
  });

  it('a board’s name moves it with the arrow keys (8px, Shift 40px), saved once the moves settle; ⌘Z undoes', async () => {
    await ready();
    const handle = screen.getByRole('button', {
      name: fill(d.boardName, { screen: 'Checkout', size: 'Phone' }),
    });
    expect(handle.getAttribute('aria-describedby')).not.toBeNull();
    handle.focus();
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
    expect(boardAt('checkout/phone.html')).toEqual({ left: 2760, top: 8 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(setLayouts().at(-1)?.input).toMatchObject({
      layout: { version: 1, boards: { 'checkout/phone.html': { x: 2760, y: 8 } } },
    });
    fireEvent.keyDown(handle, { key: 'z', metaKey: true });
    expect(boardAt('checkout/phone.html')).toEqual({ left: 2720, top: 8 });
  });

  it('dragging a name moves the board by the pointer over the zoom, snapped to 8px', async () => {
    await ready();
    const handle = document.querySelector<HTMLElement>('[data-board-handle="checkout/phone.html"]');
    if (handle === null) throw new Error('no handle');
    fireEvent.pointerDown(handle, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 10 + 33, clientY: 10 + 3.3 });
    fireEvent.pointerUp(window, { clientX: 43, clientY: 13.3 });
    expect(boardAt('checkout/phone.html')).toEqual({ left: 2824, top: 8 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(setLayouts()).toHaveLength(1);
  });

  it('saved positions win; Tidy up puts the rows back and says so, with Undo', async () => {
    await ready({
      version: 1,
      boards: {
        'checkout/desktop.html': { x: 0, y: 0 },
        'checkout/desktop.wire.html': { x: 0, y: 1000 },
        'checkout/phone.html': { x: 1400, y: 0 },
      },
    });
    expect(boardAt('checkout/desktop.wire.html')).toEqual({ left: 0, top: 1000 });
    fireEvent.click(screen.getByRole('button', { name: d.tidy }));
    expect(boardAt('checkout/desktop.wire.html')).toEqual({ left: 0, top: 0 });
    expect(screen.getByRole('status').textContent).toContain(d.tidied);
    fireEvent.click(screen.getByRole('button', { name: d.undo }));
    expect(boardAt('checkout/desktop.wire.html')).toEqual({ left: 0, top: 1000 });
  });

  it('a board added after the layout was saved is placed beside the others, kept, and announced', async () => {
    await ready({
      version: 1,
      boards: { 'checkout/desktop.html': { x: 0, y: 0 }, 'checkout/desktop.wire.html': { x: 1360, y: 0 } },
    });
    expect(boardAt('checkout/phone.html')).toEqual({ left: 2720, top: 0 });
    expect(screen.getByRole('status').textContent).toContain(
      fill(d.added, { agent: 'Claude', screen: 'Checkout', size: d.size.phone }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(setLayouts().at(-1)?.input).toMatchObject({
      layout: { boards: { 'checkout/phone.html': { x: 2720, y: 0 } } },
    });
  });

  it('Space held shows the grab cursor and keeps the frames from taking the gesture', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: d.select }));
    expect(document.querySelectorAll('[data-board-shield]').length).toBe(0);
    fireEvent.keyDown(document.body, { code: 'Space', key: ' ' });
    expect(stage().getAttribute('data-grab')).toBe('true');
    expect(document.querySelectorAll('[data-board-shield]').length).toBe(3);
    fireEvent.keyUp(document.body, { code: 'Space', key: ' ' });
    expect(stage().getAttribute('data-grab')).toBeNull();
  });

  it('a drag on empty canvas pans', async () => {
    await ready();
    const before = viewNow();
    fireEvent.pointerDown(stage(), { button: 0, clientX: 500, clientY: 500 });
    fireEvent.pointerMove(window, { clientX: 520, clientY: 470 });
    fireEvent.pointerUp(window, { clientX: 520, clientY: 470 });
    expect(viewNow()).toEqual({ zoom: before.zoom, x: before.x + 20, y: before.y - 30 });
  });
});

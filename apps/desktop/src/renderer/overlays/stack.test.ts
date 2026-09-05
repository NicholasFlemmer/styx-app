// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUiStore } from '../state/ui-store';
import { escapeTarget, findOverlay, isTrapping, pushOverlay, topOverlay, type Overlay } from './stack';

const ask = { kind: 'toast', toast: { kind: 'error', code: 'internal', message: 'x' } } as const;

describe('overlay stack (pure)', () => {
  it('orders by z: sheet < toast < modal < palette', () => {
    let s: Overlay[] = [];
    s = pushOverlay(s, { id: 'p', kind: 'palette' });
    s = pushOverlay(s, {
      id: 's',
      kind: 'sheet',
      sheet: 'grant',
      sessionId: 'x' as never,
      askId: 'a' as never,
    });
    s = pushOverlay(s, { id: 't', ...ask });
    s = pushOverlay(s, { id: 'm', kind: 'modal', modal: 'new-project' });
    expect(s.map((o) => o.id)).toEqual(['s', 't', 'm', 'p']);
    expect(topOverlay(s)?.id).toBe('p');
    expect(isTrapping(s)).toBe(true);
    expect(isTrapping([{ id: 't', ...ask }])).toBe(false);
  });

  it('escapeTarget prefers the topmost trapping overlay over a toast', () => {
    const sheet: Overlay = { id: 's', kind: 'sheet', sheet: 'grant', sessionId: 'x' as never, askId: 'a' as never };
    const toast: Overlay = { id: 't', ...ask };
    expect(escapeTarget([sheet, toast])?.id).toBe('s');
    expect(escapeTarget([toast])?.id).toBe('t');
    expect(escapeTarget([sheet, toast, { id: 'p', kind: 'palette' }])?.id).toBe('p');
    expect(escapeTarget([])).toBeNull();
  });

  it('keeps at most one modal and one palette', () => {
    let s: Overlay[] = [];
    s = pushOverlay(s, { id: 'm1', kind: 'modal', modal: 'new-project' });
    s = pushOverlay(s, { id: 'm2', kind: 'modal', modal: 'connect', projectId: 'p' as never });
    expect(s.map((o) => o.id)).toEqual(['m2']);
    expect(findOverlay(s, 'modal')?.id).toBe('m2');
  });
});

describe('overlay stack (store)', () => {
  beforeEach(() => {
    useUiStore.setState({ overlays: [] });
    document.body.innerHTML = '<button id="invoker"></button>';
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('push records the invoker and pop restores focus to it', () => {
    const invoker = document.getElementById('invoker') as HTMLButtonElement;
    invoker.focus();
    const id = useUiStore.getState().pushOverlay({ kind: 'palette' });
    expect(useUiStore.getState().overlays[0]?.id).toBe(id);
    invoker.blur();
    expect(document.activeElement).not.toBe(invoker);
    useUiStore.getState().popOverlay();
    expect(useUiStore.getState().overlays).toHaveLength(0);
    expect(document.activeElement).toBe(invoker);
  });

  it('Esc-style pop removes only the top overlay', () => {
    const ui = useUiStore.getState();
    const sheet = ui.pushOverlay({
      kind: 'sheet',
      sheet: 'grant',
      sessionId: 'x' as never,
      askId: 'a' as never,
    });
    ui.pushOverlay({ kind: 'palette' });
    useUiStore.getState().popOverlay();
    expect(useUiStore.getState().overlays.map((o) => o.id)).toEqual([sheet]);
  });

  it('[sheet, toast] + Esc-style pop of the escape target removes the sheet and keeps the toast', () => {
    const ui = useUiStore.getState();
    const sheet = ui.pushOverlay({
      kind: 'sheet',
      sheet: 'grant',
      sessionId: 'x' as never,
      askId: 'a' as never,
    });
    const toast = ui.pushOverlay(ask);
    expect(useUiStore.getState().overlays.map((o) => o.id)).toEqual([sheet, toast]);
    const target = escapeTarget(useUiStore.getState().overlays);
    expect(target?.id).toBe(sheet);
    useUiStore.getState().popOverlay(target?.id);
    expect(useUiStore.getState().overlays.map((o) => o.id)).toEqual([toast]);
  });

  it('does not restore focus to an invoker that left the document', () => {
    const invoker = document.getElementById('invoker') as HTMLButtonElement;
    invoker.focus();
    useUiStore.getState().pushOverlay({ kind: 'modal', modal: 'new-project' });
    invoker.remove();
    useUiStore.getState().popOverlay();
    expect(document.activeElement).toBe(document.body);
  });

  it('togglePalette opens then closes', () => {
    useUiStore.getState().togglePalette();
    expect(topOverlay(useUiStore.getState().overlays)?.kind).toBe('palette');
    useUiStore.getState().togglePalette();
    expect(useUiStore.getState().overlays).toHaveLength(0);
  });
});

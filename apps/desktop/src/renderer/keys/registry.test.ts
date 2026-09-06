// @vitest-environment jsdom
import type { Platform } from '@styx/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeyRegistry } from './registry';
import { scopeChain } from './scopes';

interface KeyInit {
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

const press = (target: Element, init: KeyInit): KeyboardEvent => {
  const e = new KeyboardEvent('keydown', {
    key: init.key,
    metaKey: init.meta ?? false,
    ctrlKey: init.ctrl ?? false,
    shiftKey: init.shift ?? false,
    altKey: init.alt ?? false,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(e);
  return e;
};

/** Mod = ⌘ on darwin, Ctrl on win32. */
const mod = (platform: Platform, key: string, extra: Partial<KeyInit> = {}): KeyInit =>
  platform === 'darwin' ? { key, meta: true, ...extra } : { key, ctrl: true, ...extra };

const mount = (html: string): HTMLElement => {
  document.body.innerHTML = html;
  return document.body;
};

const make = (platform: Platform, overlayOpen = false) =>
  new KeyRegistry({ platform: () => platform, overlayOpen: () => overlayOpen });

afterEach(() => {
  document.body.innerHTML = '';
});

describe('scopeChain', () => {
  it('reads data-keyscope from the target outwards and ends in global', () => {
    mount(
      '<div data-keyscope="workspace"><div data-keyscope="chat"><textarea data-keyscope="composer"></textarea></div></div>',
    );
    const ta = document.querySelector('textarea');
    expect(scopeChain(ta, false)).toEqual(['composer', 'chat', 'workspace', 'global']);
  });
  it('prepends overlay when an overlay is open and focus is outside it', () => {
    mount('<div data-keyscope="workspace"><button></button></div>');
    expect(scopeChain(document.querySelector('button'), true)).toEqual(['overlay', 'workspace', 'global']);
    expect(scopeChain(document.body, true)).toEqual(['overlay', 'global']);
  });
});

describe.each<Platform>(['darwin', 'win32'])('KeyRegistry on %s', (platform) => {
  it('dispatches Mod+K to a global binding and stops the event', () => {
    const reg = make(platform);
    const off = reg.install(window);
    const run = vi.fn();
    reg.register({ id: 'palette', chord: 'Mod+K', scope: 'global', run });
    const body = mount('<button id="b"></button>');
    const e = press(body.querySelector('#b') as Element, mod(platform, 'k'));
    expect(run).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
    off();
  });

  it('ignores the other platform modifier', () => {
    const reg = make(platform);
    const run = vi.fn();
    reg.register({ id: 'palette', chord: 'Mod+K', scope: 'global', run });
    const body = mount('<button id="b"></button>');
    const wrong: KeyInit = platform === 'darwin' ? { key: 'k', ctrl: true } : { key: 'k', meta: true };
    reg.dispatch(press(body.querySelector('#b') as Element, wrong));
    expect(run).not.toHaveBeenCalled();
  });

  it('resolves the innermost scope first', () => {
    const reg = make(platform);
    const chat = vi.fn();
    const global = vi.fn();
    reg.register({ id: 'approve', chord: 'Mod+Enter', scope: 'chat', run: chat });
    reg.register({ id: 'approve:g', chord: 'Mod+Enter', scope: 'global', run: global });
    const body = mount('<div data-keyscope="chat"><button id="b"></button></div>');
    reg.dispatch(press(body.querySelector('#b') as Element, mod(platform, 'Enter')));
    expect(chat).toHaveBeenCalledTimes(1);
    expect(global).not.toHaveBeenCalled();
  });

  it('lets RESERVED chords through from the editor but keeps plain keys and Mod+Enter for Monaco', () => {
    const reg = make(platform);
    const palette = vi.fn();
    const accept = vi.fn();
    const approve = vi.fn();
    reg.register({ id: 'palette', chord: 'Mod+K', scope: 'global', run: palette });
    reg.register({ id: 'accept', chord: 'a', scope: 'global', run: accept });
    reg.register({ id: 'approve', chord: 'Mod+Enter', scope: 'global', run: approve });
    const body = mount('<div data-keyscope="editor"><div id="m" tabindex="0"></div></div>');
    const m = body.querySelector('#m') as Element;
    expect(reg.dispatch(press(m, mod(platform, 'k')))).toBe(true);
    expect(reg.dispatch(press(m, { key: 'a' }))).toBe(false);
    expect(reg.dispatch(press(m, mod(platform, 'Enter')))).toBe(false);
    expect(palette).toHaveBeenCalledTimes(1);
    expect(accept).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
  });

  it('bubbles Mod+Enter from the composer to chat but keeps plain Enter', () => {
    const reg = make(platform);
    const approve = vi.fn();
    const enter = vi.fn();
    reg.register({ id: 'approve', chord: 'Mod+Enter', scope: 'chat', run: approve });
    reg.register({ id: 'enter', chord: 'Enter', scope: 'chat', run: enter });
    const body = mount('<div data-keyscope="chat"><textarea data-keyscope="composer"></textarea></div>');
    const ta = body.querySelector('textarea') as Element;
    expect(reg.dispatch(press(ta, mod(platform, 'Enter')))).toBe(true);
    expect(reg.dispatch(press(ta, { key: 'Enter' }))).toBe(false);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(enter).not.toHaveBeenCalled();
  });

  it("dispatches bindings registered in the composer's own scope, plain or not, from its textarea", () => {
    const reg = make(platform);
    const cycle = vi.fn();
    const stop = vi.fn();
    const chatEsc = vi.fn();
    reg.register({ id: 'cycleMode', chord: 'Shift+Tab', scope: 'composer', run: cycle });
    reg.register({ id: 'interrupt', chord: 'Escape', scope: 'composer', run: stop });
    reg.register({ id: 'chatEsc', chord: 'Escape', scope: 'chat', run: chatEsc });
    const body = mount('<div data-keyscope="chat"><textarea data-keyscope="composer"></textarea></div>');
    const ta = body.querySelector('textarea') as Element;
    expect(reg.dispatch(press(ta, { key: 'Tab', shift: true }))).toBe(true);
    expect(reg.dispatch(press(ta, { key: 'Tab' }))).toBe(false);
    expect(reg.dispatch(press(ta, { key: 'Escape' }))).toBe(true);
    expect(cycle).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    // A non-reserved chat binding still never fires from inside the host-owned composer.
    expect(chatEsc).not.toHaveBeenCalled();
  });

  it("overlay Escape beats the composer's own Escape while an overlay is open", () => {
    const reg = make(platform, true);
    const close = vi.fn();
    const stop = vi.fn();
    reg.register({ id: 'close', chord: 'Escape', scope: 'overlay', run: close });
    reg.register({ id: 'interrupt', chord: 'Escape', scope: 'composer', run: stop });
    const body = mount('<div data-keyscope="chat"><textarea data-keyscope="composer"></textarea></div>');
    expect(reg.dispatch(press(body.querySelector('textarea') as Element, { key: 'Escape' }))).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });

  it('never fires plain keys while an input is focused', () => {
    const reg = make(platform);
    const accept = vi.fn();
    reg.register({ id: 'accept', chord: 'a', scope: 'diff', run: accept });
    const body = mount('<div data-keyscope="diff"><input id="i" /><button id="b"></button></div>');
    reg.dispatch(press(body.querySelector('#i') as Element, { key: 'a' }));
    expect(accept).not.toHaveBeenCalled();
    reg.dispatch(press(body.querySelector('#b') as Element, { key: 'a' }));
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it('routes Escape to the overlay scope even when focus sits on body', () => {
    const reg = make(platform, true);
    const close = vi.fn();
    reg.register({ id: 'close', chord: 'Escape', scope: 'overlay', run: close });
    mount('<div data-keyscope="workspace"></div>');
    reg.dispatch(press(document.body, { key: 'Escape' }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('honours `when` gates and `false` returns', () => {
    const reg = make(platform);
    const gated = vi.fn();
    const declined = vi.fn(() => false);
    const fallback = vi.fn();
    reg.register({ id: 'gated', chord: 'Mod+1', scope: 'global', when: () => false, run: gated });
    reg.register({ id: 'declined', chord: 'Mod+1', scope: 'global', run: declined });
    reg.register({ id: 'fallback', chord: 'Mod+1', scope: 'global', run: fallback });
    const body = mount('<button id="b"></button>');
    reg.dispatch(press(body.querySelector('#b') as Element, mod(platform, '1')));
    expect(gated).not.toHaveBeenCalled();
    expect(declined).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('unregisters', () => {
    const reg = make(platform);
    const run = vi.fn();
    const off = reg.register({ id: 'x', chord: 'Mod+Shift+T', scope: 'global', run });
    off();
    const body = mount('<button id="b"></button>');
    reg.dispatch(press(body.querySelector('#b') as Element, mod(platform, 't', { shift: true })));
    expect(run).not.toHaveBeenCalled();
  });
});

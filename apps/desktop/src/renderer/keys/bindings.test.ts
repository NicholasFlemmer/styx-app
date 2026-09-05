// @vitest-environment jsdom
import { fixtures, sessionTabs, type ProjectId } from '@styx/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../state/read-model';
import { selectSessionId, useUiStore } from '../state/ui-store';
import { popoutBindings, shellBindings } from './bindings';
import { KeyRegistry } from './registry';

/** Dispatches from inside the workspace scope (spec §6: approve/deny are chat/workspace chords). */
const press = (init: KeyboardEventInit) => {
  let host = document.querySelector<HTMLElement>('[data-keyscope="workspace"]');
  if (host === null) {
    host = document.createElement('div');
    host.setAttribute('data-keyscope', 'workspace');
    document.body.append(host);
  }
  host.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
};

describe('shell bindings', () => {
  let reg: KeyRegistry;
  let off: () => void;
  const commands: string[] = [];

  beforeEach(() => {
    commands.length = 0;
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: {},
        command: vi.fn(async (name: string) => {
          commands.push(name);
          return { ok: true, value: {} };
        }),
      },
    });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({
      overlays: [],
      screen: 'workspace',
      projectId: fixtures.ids.project.acmeShop as ProjectId,
    });
    reg = new KeyRegistry({
      platform: () => 'darwin',
      overlayOpen: () => useUiStore.getState().overlays.length > 0,
    });
    reg.registerAll(shellBindings());
    off = reg.install(window);
  });
  afterEach(() => {
    off();
    document.body.innerHTML = '';
    Object.assign(window, { styx: undefined });
  });

  it('Mod+K toggles the palette; Escape pops it', () => {
    press({ key: 'k', metaKey: true });
    expect(useUiStore.getState().overlays.map((o) => o.kind)).toEqual(['palette']);
    press({ key: 'k', metaKey: true });
    expect(useUiStore.getState().overlays).toHaveLength(0);
    press({ key: 'k', metaKey: true });
    press({ key: 'Escape' });
    expect(useUiStore.getState().overlays).toHaveLength(0);
  });

  it('Mod+P opens the palette in the Projects scope', () => {
    press({ key: 'p', metaKey: true });
    expect(useUiStore.getState().palette.scope).toBe('projects');
    expect(useUiStore.getState().overlays[0]?.kind).toBe('palette');
  });

  it('Mod+1–4 focus the nth session tab of the project', () => {
    const model = useReadModel.getState().model;
    const tabs = sessionTabs(model, fixtures.ids.project.acmeShop as ProjectId, null);
    press({ key: '2', metaKey: true });
    expect(selectSessionId(useUiStore.getState())).toBe(tabs.visible[1]?.sessionId);
  });

  it('Mod+Shift+N opens the spawn modal for the active project', () => {
    press({ key: 'n', metaKey: true, shiftKey: true });
    const top = useUiStore.getState().overlays[0];
    expect(top?.kind === 'modal' && top.modal === 'spawn').toBe(true);
  });

  it('Mod+Enter approves the head ask of the active session with 1h and its scope', () => {
    const codex = fixtures.ids.session.codex;
    useUiStore.getState().openSession(fixtures.ids.project.acmeShop as ProjectId, codex);
    press({ key: 'Enter', metaKey: true });
    expect(commands).toEqual(['grant.approve']);
    const call = (window as unknown as { styx: { command: ReturnType<typeof vi.fn> } }).styx.command.mock
      .calls[0];
    expect(call?.[1]).toMatchObject({ duration: '1h' });
    expect(Array.isArray(call?.[1]?.scope)).toBe(true);
  });

  it('Mod+Backspace denies; nothing happens without a pending grant ask', () => {
    useUiStore.getState().openSession(fixtures.ids.project.acmeShop as ProjectId, fixtures.ids.session.codex);
    press({ key: 'Backspace', metaKey: true });
    expect(commands).toEqual(['grant.deny']);
    commands.length = 0;
    // The blog session's head ask is a plan, not a grant: Mod+Backspace must be a no-op there.
    const blog = useReadModel.getState().model.sessions.byId[fixtures.ids.session.blog];
    if (blog === undefined) throw new Error('fixture has no blog session');
    useUiStore.getState().openSession(blog.projectId, blog.id);
    press({ key: 'Backspace', metaKey: true });
    expect(commands).toEqual([]);
  });

  it('Mod+Shift+T cycles the theme via settings.set', () => {
    press({ key: 't', metaKey: true, shiftKey: true });
    expect(commands).toEqual(['settings.set']);
  });

  it('Mod+Shift+O pops out the active session', () => {
    useUiStore
      .getState()
      .openSession(fixtures.ids.project.acmeShop as ProjectId, fixtures.ids.session.claude);
    press({ key: 'o', metaKey: true, shiftKey: true });
    expect(commands).toEqual(['window.popout']);
  });
});

describe('popout bindings (spec §4.13)', () => {
  let reg: KeyRegistry;
  let off: () => void;
  const commands: { name: string; input: unknown }[] = [];
  const claude = fixtures.ids.session.claude;

  /** Dispatches from the composer textarea inside the pop-out's chat scope. */
  const pressInComposer = (init: KeyboardEventInit) => {
    let box = document.querySelector<HTMLTextAreaElement>('[data-keyscope="composer"] textarea');
    if (box === null) {
      const chat = document.createElement('div');
      chat.setAttribute('data-keyscope', 'chat');
      const composer = document.createElement('div');
      composer.setAttribute('data-keyscope', 'composer');
      box = document.createElement('textarea');
      composer.append(box);
      chat.append(composer);
      document.body.append(chat);
    }
    box.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  };

  beforeEach(() => {
    commands.length = 0;
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: {},
        command: vi.fn(async (name: string, input: unknown) => {
          commands.push({ name, input });
          return { ok: true, value: {} };
        }),
      },
    });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({ overlays: [], screen: 'workspace', projectId: null });
    reg = new KeyRegistry({
      platform: () => 'darwin',
      overlayOpen: () => useUiStore.getState().overlays.length > 0,
    });
    reg.registerAll(popoutBindings(claude));
    off = reg.install(window);
  });
  afterEach(() => {
    off();
    document.body.innerHTML = '';
    Object.assign(window, { styx: undefined });
  });

  it('Mod+Shift+O docks the window, even from the composer', () => {
    pressInComposer({ key: 'o', metaKey: true, shiftKey: true });
    expect(commands).toEqual([{ name: 'window.dock', input: { sessionId: claude } }]);
  });

  it('has no palette: Mod+K and Mod+P do nothing, Escape does nothing', () => {
    pressInComposer({ key: 'k', metaKey: true });
    pressInComposer({ key: 'p', metaKey: true });
    pressInComposer({ key: 'Escape' });
    expect(useUiStore.getState().overlays).toHaveLength(0);
    expect(commands).toEqual([]);
    expect(reg.list().map((b) => b.scope)).toEqual(['global', 'global']);
  });
});


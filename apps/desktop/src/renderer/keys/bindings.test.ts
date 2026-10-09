// @vitest-environment jsdom
import { fixtures, navLanes, upsertRows, type ProjectId } from '@styx/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../state/read-model';
import { selectSessionId, useUiStore } from '../state/ui-store';
import { approveGrantAsRequested, boardBindings, popoutBindings, shellBindings } from './bindings';
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

  it('Escape pops the trapping sheet before the toast ([sheet, toast] → [toast])', () => {
    const ui = useUiStore.getState();
    const sheet = ui.pushOverlay({
      kind: 'sheet',
      sheet: 'grant',
      sessionId: fixtures.ids.session.codex,
      askId: fixtures.ids.ask.codexGrant,
    });
    const toast = ui.pushOverlay({
      kind: 'toast',
      toast: {
        kind: 'ask',
        askId: fixtures.ids.ask.codexGrant,
        sessionId: fixtures.ids.session.codex,
        projectId: fixtures.ids.project.acmeShop as ProjectId,
      },
    });
    expect(useUiStore.getState().overlays.map((o) => o.id)).toEqual([sheet, toast]);
    // From `body` (no scoped ancestor): the registry prepends `overlay` while any overlay is open.
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(useUiStore.getState().overlays.map((o) => o.id)).toEqual([toast]);
    // Nothing traps any more: Esc now dismisses the toast.
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(useUiStore.getState().overlays).toHaveLength(0);
  });

  it('Mod+P opens the palette in the Projects scope', () => {
    press({ key: 'p', metaKey: true });
    expect(useUiStore.getState().palette.scope).toBe('projects');
    expect(useUiStore.getState().overlays[0]?.kind).toBe('palette');
  });

  it('Mod+1–4 open the nth lane of the project, in the nav’s order (ADR-0027 §1)', () => {
    const model = useReadModel.getState().model;
    const lanes = navLanes(model, fixtures.ids.project.acmeShop as ProjectId, Date.now());
    press({ key: '2', metaKey: true });
    expect(selectSessionId(useUiStore.getState())).toBe(lanes[1]?.sessionId);
  });

  it('Mod+Shift+N opens New task in the active project’s workspace (ADR-0027 §1)', () => {
    press({ key: 'n', metaKey: true, shiftKey: true });
    expect(useUiStore.getState().newTask).toEqual({ projectId: fixtures.ids.project.acmeShop, text: '' });
    expect(useUiStore.getState().screen).toBe('workspace');
  });

  it('Mod+Enter approves the head ask of the active session with its scope, 1h unless the request allows only once', () => {
    const codex = fixtures.ids.session.codex;
    useUiStore.getState().openSession(fixtures.ids.project.acmeShop as ProjectId, codex);
    press({ key: 'Enter', metaKey: true });
    expect(commands).toEqual(['grant.approve']);
    const call = (window as unknown as { styx: { command: ReturnType<typeof vi.fn> } }).styx.command.mock
      .calls[0];
    // The Codex ask is a Supabase prod write and Supabase's token can't be narrowed: once only (issue #29).
    expect(call?.[1]).toMatchObject({ duration: 'once' });
    expect(Array.isArray(call?.[1]?.scope)).toBe(true);
  });

  it('approving a request the cap does not touch (a prod read) as requested sends 1h', () => {
    const grant = useReadModel.getState().model.grants.byId[fixtures.ids.grant.awsClaude];
    if (grant === undefined) throw new Error('fixture grant');
    approveGrantAsRequested(grant);
    const call = (window as unknown as { styx: { command: ReturnType<typeof vi.fn> } }).styx.command.mock
      .calls[0];
    expect(call?.[1]).toMatchObject({ grantId: grant.id, duration: '1h', scope: ['read'] });
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

  it('Mod+Shift+T toggles the theme from the resolved look, so a press always shows (spec §6 "Toggle theme")', () => {
    const inputs: unknown[] = [];
    (window as unknown as { styx: { command: unknown } }).styx.command = vi.fn(
      async (name: string, input: unknown) => {
        commands.push(name);
        inputs.push(input);
        return { ok: true, value: {} };
      },
    );
    // `system` preference on a dark OS: the visible look is dark, so the toggle goes to light, not to dark.
    useReadModel.getState().replaceModel(
      {
        ...fixtures.demoReadModel(),
        settings: {
          ...fixtures.demoReadModel().settings,
          app: { ...fixtures.demoReadModel().settings.app, theme: 'system' },
        },
      },
      'connected',
    );
    useUiStore.setState({ resolvedTheme: 'dark' });
    press({ key: 't', metaKey: true, shiftKey: true });
    useUiStore.setState({ resolvedTheme: 'light' });
    press({ key: 't', metaKey: true, shiftKey: true });
    expect(commands).toEqual(['settings.set', 'settings.set']);
    expect(inputs).toEqual([{ patch: { theme: 'light' } }, { patch: { theme: 'dark' } }]);
  });

  it('Mod+Shift+O pops out the active session', () => {
    useUiStore
      .getState()
      .openSession(fixtures.ids.project.acmeShop as ProjectId, fixtures.ids.session.claude);
    press({ key: 'o', metaKey: true, shiftKey: true });
    expect(commands).toEqual(['window.popout']);
  });
});

describe('board bindings (spec §6 "board card")', () => {
  let reg: KeyRegistry;
  let off: () => void;
  const calls: string[] = [];

  beforeEach(() => {
    calls.length = 0;
    document.body.innerHTML = '<div data-keyscope="board"><button id="cta">Review grant</button></div>';
    reg = new KeyRegistry({ platform: () => 'darwin', overlayOpen: () => false });
    reg.registerAll(
      boardBindings({
        approve: () => {
          calls.push('approve');
        },
        deny: () => {
          calls.push('deny');
        },
      }),
    );
    off = reg.install(window);
  });
  afterEach(() => {
    off();
    document.body.innerHTML = '';
  });

  it('Mod+⏎ / Mod+⌫ fire only inside the board scope', () => {
    const card = document.querySelector('[data-keyscope="board"]') as HTMLElement;
    card.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }),
    );
    card.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', metaKey: true, bubbles: true, cancelable: true }),
    );
    expect(calls).toEqual(['approve', 'deny']);
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }),
    );
    expect(calls).toEqual(['approve', 'deny']);
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

  it('has no palette or overlay close: Mod+K and Mod+P do nothing, Escape only reaches the composer', () => {
    pressInComposer({ key: 'k', metaKey: true });
    pressInComposer({ key: 'p', metaKey: true });
    pressInComposer({ key: 'Escape' });
    expect(useUiStore.getState().overlays).toHaveLength(0);
    // The pinned Claude session is mid-turn, so Esc interrupts it (composer scope); nothing else fires.
    expect(commands.map((c) => c.name)).toEqual(['session.interrupt']);
    expect(reg.list().map((b) => b.scope)).toEqual(['global', 'global', 'composer', 'composer']);
  });

  it('Escape in the pop-out composer interrupts its pinned session while it is working', () => {
    pressInComposer({ key: 'Escape' });
    expect(commands).toEqual([{ name: 'session.interrupt', input: { sessionId: claude } }]);
  });
});

describe('composer bindings (Claude Code parity, discrepancy #54)', () => {
  let reg: KeyRegistry;
  let off: () => void;
  const commands: { name: string; input: unknown }[] = [];
  const acme = fixtures.ids.project.acmeShop as ProjectId;
  const claude = fixtures.ids.session.claude;

  const composerBox = (): HTMLTextAreaElement => {
    let box = document.querySelector<HTMLTextAreaElement>('[data-keyscope="composer"] textarea');
    if (box === null) {
      const ws = document.createElement('div');
      ws.setAttribute('data-keyscope', 'workspace');
      const chat = document.createElement('div');
      chat.setAttribute('data-keyscope', 'chat');
      const composer = document.createElement('div');
      composer.setAttribute('data-keyscope', 'composer');
      box = document.createElement('textarea');
      composer.append(box);
      chat.append(composer);
      ws.append(chat);
      document.body.append(ws);
    }
    return box;
  };
  const pressInComposer = (init: KeyboardEventInit): boolean =>
    composerBox().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

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
    useUiStore.setState({ overlays: [], screen: 'workspace', projectId: acme, projectSession: {} });
    useUiStore.getState().openSession(acme, claude);
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

  it('Escape interrupts the working Claude session (default prevented)', () => {
    const notHandled = pressInComposer({ key: 'Escape' });
    expect(notHandled).toBe(false);
    expect(commands).toEqual([{ name: 'session.interrupt', input: { sessionId: claude } }]);
  });

  it('Escape closes an open overlay first and leaves the session running', () => {
    useUiStore.getState().pushOverlay({
      kind: 'sheet',
      sheet: 'grant',
      sessionId: fixtures.ids.session.codex,
      askId: fixtures.ids.ask.codexGrant,
    });
    pressInComposer({ key: 'Escape' });
    expect(useUiStore.getState().overlays).toHaveLength(0);
    expect(commands).toEqual([]);
    pressInComposer({ key: 'Escape' });
    expect(commands).toEqual([{ name: 'session.interrupt', input: { sessionId: claude } }]);
  });

  it('Escape falls through when the session is not working (idle Gemini, pty Codex)', () => {
    useUiStore.getState().openSession(acme, fixtures.ids.session.gemini);
    expect(pressInComposer({ key: 'Escape' })).toBe(true);
    useUiStore.getState().openSession(acme, fixtures.ids.session.codex);
    expect(pressInComposer({ key: 'Escape' })).toBe(true);
    expect(commands).toEqual([]);
  });

  it('⇧⇥ cycles the permission mode default → acceptEdits → plan → default via session.configure', () => {
    pressInComposer({ key: 'Tab', shiftKey: true });
    expect(commands).toEqual([
      { name: 'session.configure', input: { sessionId: claude, permissionMode: 'acceptEdits' } },
    ]);
    const model = useReadModel.getState().model;
    const s = model.sessions.byId[claude];
    if (s === undefined) throw new Error('fixture');
    useReadModel
      .getState()
      .replaceModel(
        { ...model, sessions: upsertRows(model.sessions, [{ ...s, permissionMode: 'plan' }]) },
        'connected',
      );
    pressInComposer({ key: 'Tab', shiftKey: true });
    expect(commands[1]).toEqual({
      name: 'session.configure',
      input: { sessionId: claude, permissionMode: 'default' },
    });
    // Plain ⇥ is the textarea's own.
    expect(pressInComposer({ key: 'Tab' })).toBe(true);
    expect(commands).toHaveLength(2);
  });

  it('⇧⇥ does nothing for agents without a permission mode', () => {
    useUiStore.getState().openSession(acme, fixtures.ids.session.codex);
    expect(pressInComposer({ key: 'Tab', shiftKey: true })).toBe(true);
    expect(commands).toEqual([]);
  });
});

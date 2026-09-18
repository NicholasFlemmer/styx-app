// @vitest-environment jsdom
import {
  copy,
  fill,
  fixtures,
  projectSettingsOfOrDefault,
  type DevPlatform,
  type DevRun,
  type DeviceSession,
  type DeviceSummary,
  type ReadModel,
  type Session,
} from '@styx/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { DesignPane } from './DesignPane';

// xterm needs a real layout engine; the pane only needs the entry to be created, attached and disposed.
vi.mock('../modals/login-terminal', () => ({
  createLoginTerminal: vi.fn((terminalId: string) => ({
    terminalId,
    term: { focus: vi.fn(), dispose: vi.fn() },
  })),
  disposeLoginTerminal: vi.fn(),
}));
vi.mock('../terminal/terminal-registry', () => ({
  attachTerminal: vi.fn(),
  detachTerminal: vi.fn(),
  isReservedKey: () => false,
}));
const loginTerminal = await import('../modals/login-terminal');
const registry = await import('../terminal/terminal-registry');

const acme = fixtures.ids.project.acmeShop;
const commands: { name: string; input: unknown }[] = [];
const sets = () =>
  commands.filter((c) => c.name === 'preview.set').map((c) => c.input as Record<string, unknown>);
const of = (name: string) => commands.filter((c) => c.name === name).map((c) => c.input);
let suggestions: { command: string; source: string }[] = [{ command: 'pnpm dev', source: 'package.json' }];
let platforms: DevPlatform[] = ['web'];
let tooling = { ios: true, android: true, iosInput: false, androidInput: true, screenAccess: 'granted' };
let devices: DeviceSummary[] = [];
let mirrorAnswer: { mode: 'window' | 'screenshots' | 'none'; reason: string | null } = {
  mode: 'screenshots',
  reason: null,
};
// `window.styx.onEvent` fake: the pane subscribes to `device.frame` / `preview.status`; tests emit into it.
const listeners = new Map<string, Set<(payload: unknown) => void>>();
const emit = (name: string, payload: unknown) => {
  act(() => {
    listeners.get(name)?.forEach((cb) => cb(payload));
  });
};

const run = (over: Partial<DevRun> = {}): DevRun => ({
  projectId: acme,
  runId: 'run:1',
  terminalId: 'term:1',
  command: 'pnpm dev',
  platform: 'web',
  phase: 'running',
  url: null,
  exitCode: null,
  startedAt: fixtures.DEMO_NOW - 5_000,
  endedAt: null,
  ...over,
});

const device = (over: Partial<DeviceSession> = {}): DeviceSession => ({
  projectId: acme,
  platform: 'ios',
  deviceId: 'UDID-1',
  deviceName: 'iPhone 17 Pro',
  phase: 'ready',
  mirror: 'screenshots',
  input: true,
  error: null,
  screen: { width: 1179, height: 2556 },
  startedAt: fixtures.DEMO_NOW,
  ...over,
});

const sims: DeviceSummary[] = [
  { platform: 'ios', id: 'UDID-1', name: 'iPhone 17 Pro', runtime: 'iOS 26.5', state: 'booted' },
  { platform: 'ios', id: 'UDID-2', name: 'iPhone 17 Pro', runtime: 'iOS 25.0', state: 'shutdown' },
  { platform: 'ios', id: 'UDID-3', name: 'iPad Air', runtime: 'iOS 26.5', state: 'shutdown' },
];

const pane = (props: Partial<Parameters<typeof DesignPane>[0]> = {}) => (
  <DesignPane
    projectId={acme}
    devUrl="localhost:3000"
    active
    run={null}
    devCommand={null}
    device={null}
    devPlatform={null}
    devDevice={null}
    {...props}
  />
);

/** The demo model plus a live session `id` on acme-shop (a copy of the Gemini session). */
const withSession = (m: ReadModel, id: string): ReadModel => {
  const base = m.sessions.byId[fixtures.ids.session.gemini];
  if (base === undefined) throw new Error('fixture');
  const sid = id as Session['id'];
  return {
    ...m,
    sessions: {
      byId: { ...m.sessions.byId, [sid]: { ...base, id: sid, projectId: acme, state: 'working' } },
      ids: [...m.sessions.ids, sid],
    },
  };
};
const defaultAgent = () =>
  copy.agentProducts[projectSettingsOfOrDefault(fixtures.demoReadModel(), acme).defaultAgent];

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  }) as DOMRect;

/** A stream as `getDisplayMedia` would hand back: an EventTarget with one video track. */
const fakeStream = () => {
  const track = Object.assign(new EventTarget(), { stop: vi.fn(), kind: 'video' });
  return Object.assign(new EventTarget(), {
    getTracks: () => [track],
    getVideoTracks: () => [track],
    track,
  });
};

describe('DesignPane', () => {
  beforeEach(() => {
    commands.length = 0;
    listeners.clear();
    suggestions = [{ command: 'pnpm dev', source: 'package.json' }];
    platforms = ['web'];
    tooling = { ios: true, android: true, iosInput: false, androidInput: true, screenAccess: 'granted' };
    devices = [];
    mirrorAnswer = { mode: 'screenshots', reason: null };
    vi.mocked(loginTerminal.createLoginTerminal).mockClear();
    vi.mocked(loginTerminal.disposeLoginTerminal).mockClear();
    vi.mocked(registry.attachTerminal).mockClear();
    vi.mocked(registry.detachTerminal).mockClear();
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: fixtures.DEMO_NOW },
        command: vi.fn(async (name: string, input: unknown) => {
          commands.push({ name, input });
          if (name === 'run.detect') return { ok: true, value: { suggestions, platforms } };
          if (name === 'device.tooling') return { ok: true, value: tooling };
          if (name === 'device.list') return { ok: true, value: { devices } };
          if (name === 'device.mirror') return { ok: true, value: mirrorAnswer };
          if (name === 'session.spawn') return { ok: true, value: { sessionId: 's-learn' } };
          return { ok: true, value: {} };
        }),
        onEvent: (name: string, cb: (payload: unknown) => void) => {
          const set = listeners.get(name) ?? new Set();
          set.add(cb);
          listeners.set(name, set);
          return () => set.delete(cb);
        },
      },
    });
    // jsdom has no layout engine: the hole gets a size; the screen slot inside a frame takes the frame's screen
    // size (so a rotate shows up in what is reported); the mirror surface sits at (100, 50) at half scale.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.hasAttribute('data-preview-slot')) {
        const sc = this.closest('[data-screen]') as HTMLElement | null;
        return rect(300, 120, parseInt(sc?.style.width ?? '0', 10), parseInt(sc?.style.height ?? '0', 10));
      }
      if (this.hasAttribute('data-device-surface')) return rect(100, 50, 393, 852);
      return rect(220, 80, 900, 600);
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({
      overlays: [],
      screen: 'workspace',
      platform: 'darwin',
      projectId: acme,
      projectSession: {},
      learning: {},
      taskLaunches: {},
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Object.assign(window, { styx: undefined });
  });

  it('reports the hole it measured so main can position the native view over it', async () => {
    render(pane());
    await waitFor(() => expect(sets().length).toBeGreaterThan(0));
    expect(sets()[0]).toMatchObject({
      visible: true,
      url: 'localhost:3000',
      device: 'desktop',
      bounds: { x: 220, y: 80, width: 900, height: 600 },
    });
  });

  it('hides while an overlay is open: a native view paints above the DOM', async () => {
    render(pane());
    await waitFor(() => expect(sets().length).toBeGreaterThan(0));
    commands.length = 0;
    useUiStore.setState({ overlays: [{ id: 'o1', kind: 'modal', modal: 'spawn', projectId: acme }] });
    await waitFor(() => expect(sets().at(-1)).toMatchObject({ visible: false }));
  });

  it('stays hidden with no URL, and shows the hint instead', async () => {
    render(pane({ devUrl: null }));
    await waitFor(() => expect(sets().length).toBeGreaterThan(0));
    expect(sets().at(-1)).toMatchObject({ visible: false });
    expect(screen.getByText(copy.workspace.design.empty)).toBeTruthy();
    expect(screen.getByText(copy.workspace.design.hint)).toBeTruthy();
  });

  it('hides when the Code tab is showing rather than sitting behind the editor', async () => {
    render(pane({ active: false }));
    await waitFor(() => expect(sets().length).toBeGreaterThan(0));
    expect(sets().at(-1)).toMatchObject({ visible: false });
  });

  it('a device preset frames the page and reports the screen slot, without touching the saved URL', async () => {
    render(pane());
    await waitFor(() => expect(sets().length).toBeGreaterThan(0));
    expect(document.querySelector('[data-preview-rotate]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: copy.workspace.design.devices.phone }));
    await waitFor(() =>
      expect(sets().at(-1)).toMatchObject({
        device: 'phone',
        visible: true,
        bounds: { x: 300, y: 120, width: 393, height: 852 },
      }),
    );
    const frame = screen.getByRole('group', { name: 'Phone frame' });
    expect(frame.getAttribute('data-kind')).toBe('phone');
    expect(frame.querySelector('[data-preview-slot]')).not.toBeNull();
    expect(of('project.settings.set')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: copy.workspace.design.devices.tablet }));
    await waitFor(() => expect(screen.getByRole('group', { name: 'Tablet frame' })).toBeTruthy());
    await waitFor(() =>
      expect(sets().at(-1)).toMatchObject({ device: 'tablet', bounds: { width: 834, height: 1112 } }),
    );
    // Back to desktop: no frame, the whole hole again.
    fireEvent.click(screen.getByRole('button', { name: copy.workspace.design.devices.desktop }));
    await waitFor(() =>
      expect(sets().at(-1)).toMatchObject({ device: 'desktop', bounds: { width: 900, height: 600 } }),
    );
    expect(screen.queryByRole('group', { name: /frame$/ })).toBeNull();
  });

  it('Rotate turns the frame on its side and the reported slot with it', async () => {
    render(pane());
    fireEvent.click(screen.getByRole('button', { name: copy.workspace.design.devices.phone }));
    const rotate = screen.getByRole('button', { name: copy.workspace.design.rotate });
    expect(rotate.getAttribute('aria-pressed')).toBe('false');
    expect(rotate.hasAttribute('data-preview-rotate')).toBe(true);
    fireEvent.click(rotate);
    expect(rotate.getAttribute('aria-pressed')).toBe('true');
    const frame = screen.getByRole('group', { name: 'Phone frame' });
    expect(frame.getAttribute('data-landscape')).toBe('true');
    expect((frame.querySelector('[data-screen]') as HTMLElement).style.width).toBe('852px');
    await waitFor(() =>
      expect(sets().at(-1)).toMatchObject({ device: 'phone', bounds: { width: 852, height: 393 } }),
    );
    fireEvent.click(rotate);
    await waitFor(() => expect(sets().at(-1)).toMatchObject({ bounds: { width: 393, height: 852 } }));
  });

  it('Enter in the URL field saves it to the project settings', async () => {
    render(pane({ devUrl: null }));
    const field = screen.getByLabelText(copy.workspace.design.urlLabel);
    fireEvent.change(field, { target: { value: 'localhost:5173' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(of('project.settings.set')).toEqual([{ projectId: acme, patch: { devUrl: 'localhost:5173' } }]);
  });

  it('unmounting detaches the view', async () => {
    const { unmount } = render(pane());
    await waitFor(() => expect(sets().length).toBeGreaterThan(0));
    commands.length = 0;
    unmount();
    expect(sets().at(-1)).toMatchObject({ visible: false, url: '' });
  });

  describe('run locally', () => {
    it('nothing learned yet: no command field, a first-time hint naming the agent, and Run hands the job to the agent', async () => {
      render(pane({ devUrl: null }));
      // Mount detection is what decides whether the platform chips show.
      await waitFor(() => expect(of('run.detect')).toEqual([{ projectId: acme }]));
      expect(screen.queryByLabelText(copy.workspace.run.command)).toBeNull();
      expect(document.querySelector('[data-run-first-time]')?.textContent).toBe(
        fill(copy.workspace.run.firstTime, { agent: defaultAgent() }),
      );
      expect(document.querySelector('[data-run-strip]')).toBeNull();
      const button = screen.getByRole('button', { name: /Run locally/ });
      expect(button.hasAttribute('disabled')).toBe(false);
      fireEvent.click(button);
      await waitFor(() => expect(of('session.spawn')).toHaveLength(1));
      expect(of('run.start')).toEqual([]);
      // Styx's own detection rides along as a hint the agent must check.
      expect(of('run.detect')).toEqual([{ projectId: acme }, { projectId: acme }]);
      expect(of('session.spawn')[0]).toMatchObject({
        projectId: acme,
        toggles: { mayRequestTargets: false, autoApproveEdits: false },
      });
      const first = (of('session.spawn')[0] as { firstMessage: string }).firstMessage;
      expect(first).toContain('run acme-shop locally');
      expect(first).toContain('`pnpm dev` (from package.json)');
      expect(first).toContain('remember_command');
      expect(useUiStore.getState().projectSession[acme]).toBeUndefined();
      expect(useUiStore.getState().overlays).toContainEqual(
        expect.objectContaining({ kind: 'task', taskKey: `run:${acme}` }),
      );
      expect(useUiStore.getState().learning[`run:${acme}`]).toBe('s-learn');
    });

    it('while the agent works it out the row says so and opens progress; a learned command ends it', async () => {
      useReadModel.getState().replaceModel(withSession(fixtures.demoReadModel(), 's-learn'), 'connected');
      useUiStore.setState({ learning: { [`run:${acme}`]: 's-learn' as Session['id'] } });
      const { rerender } = render(pane({ devUrl: null }));
      expect(screen.queryByRole('button', { name: /Run locally/ })).toBeNull();
      expect(document.querySelector('[data-run-learning]')?.textContent).toBe(
        fill(copy.workspace.run.learning, { agent: copy.agentProducts.gemini }),
      );
      fireEvent.click(screen.getByRole('button', { name: copy.workspace.run.openChat }));
      expect(useUiStore.getState().projectSession[acme]).toBeUndefined();
      expect(useUiStore.getState().overlays).toContainEqual(
        expect.objectContaining({ kind: 'task', taskKey: `run:${acme}` }),
      );
      // remember_command landed: the command shows in the field and Run is a plain button again.
      rerender(pane({ devUrl: null, devCommand: 'pnpm dev' }));
      await waitFor(() => expect(useUiStore.getState().learning[`run:${acme}`]).toBeUndefined());
      expect((screen.getByLabelText(copy.workspace.run.command) as HTMLInputElement).value).toBe('pnpm dev');
      expect(screen.getByRole('button', { name: /Run locally/ })).toBeTruthy();
    });

    it('a learned command shows in the field; clearing it disables Run; blur saves an edit', async () => {
      render(pane({ devCommand: 'make dev' }));
      const field = screen.getByLabelText(copy.workspace.run.command) as HTMLInputElement;
      expect(field.value).toBe('make dev');
      expect(field.getAttribute('placeholder')).toBe(copy.workspace.run.commandPlaceholder);
      expect(document.querySelector('[data-run-first-time]')).toBeNull();
      fireEvent.change(field, { target: { value: '   ' } });
      const button = screen.getByRole('button', { name: /Run locally/ });
      expect(button.hasAttribute('disabled')).toBe(true);
      fireEvent.click(button);
      expect(of('run.start')).toEqual([]);
      fireEvent.change(field, { target: { value: ' npm run dev ' } });
      fireEvent.blur(field);
      expect(of('project.settings.set')).toEqual([{ projectId: acme, patch: { devCommand: 'npm run dev' } }]);
    });

    it('a failed run offers to ask the agent to fix it, with the command and what went wrong', async () => {
      const { rerender } = render(
        pane({
          devCommand: 'pnpm dev',
          run: run({ phase: 'exited', exitCode: 1, endedAt: fixtures.DEMO_NOW }),
        }),
      );
      const fix = screen.getByRole('button', {
        name: fill(copy.workspace.run.askToFix, { agent: defaultAgent() }),
      });
      fireEvent.click(fix);
      await waitFor(() => expect(of('session.spawn')).toHaveLength(1));
      const first = (of('session.spawn')[0] as { firstMessage: string }).firstMessage;
      expect(first).toContain('`pnpm dev`');
      expect(first).toContain('exited with code 1');
      // The fix prompt carries no fresh detection (only the mount's).
      expect(of('run.detect')).toEqual([{ projectId: acme }]);
      // Exit 0 without ever answering on a URL is a failure too; a clean exit with a URL is not.
      rerender(
        pane({
          devCommand: 'pnpm dev',
          run: run({ phase: 'exited', exitCode: 0, endedAt: fixtures.DEMO_NOW }),
        }),
      );
      expect(document.querySelector('[data-run-fix]')).not.toBeNull();
      rerender(
        pane({
          devCommand: 'pnpm dev',
          run: run({
            phase: 'exited',
            exitCode: 0,
            url: 'http://localhost:5173',
            endedAt: fixtures.DEMO_NOW,
          }),
        }),
      );
      expect(document.querySelector('[data-run-fix]')).toBeNull();
      // A device run never has a URL: a clean exit is a clean exit.
      rerender(
        pane({
          devCommand: 'npx expo run:ios',
          run: run({ platform: 'ios', phase: 'exited', exitCode: 0, endedAt: fixtures.DEMO_NOW }),
        }),
      );
      expect(document.querySelector('[data-run-fix]')).toBeNull();
    });

    it('Run locally and Enter in the command field both start the run with the command shown, on the web', async () => {
      render(pane({ devCommand: 'pnpm dev' }));
      fireEvent.click(screen.getByRole('button', { name: /Run locally/ }));
      expect(of('run.start')).toEqual([{ projectId: acme, command: 'pnpm dev', platform: 'web' }]);
      const field = screen.getByLabelText(copy.workspace.run.command);
      fireEvent.change(field, { target: { value: '  npm run dev  ' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(of('run.start').at(-1)).toEqual({ projectId: acme, command: 'npm run dev', platform: 'web' });
    });

    it('while the run is live the button is Stop (armed) and dispatches run.stop; the field is locked', async () => {
      render(pane({ run: run({ phase: 'starting' }) }));
      expect(screen.queryByRole('button', { name: /Run locally/ })).toBeNull();
      const stop = screen.getByRole('button', { name: /Stop/ });
      expect(stop.getAttribute('data-on')).toBe('true');
      expect((screen.getByLabelText(copy.workspace.run.command) as HTMLInputElement).disabled).toBe(true);
      fireEvent.click(stop);
      expect(of('run.stop')).toEqual([{ projectId: acme }]);
      expect(of('run.start')).toEqual([]);
    });

    it('the output strip shows the phase, attaches a terminal to the run pty, and collapses / expands', async () => {
      const { rerender } = render(pane({ run: run({ phase: 'starting' }) }));
      const strip = document.querySelector('[data-run-strip]');
      expect(strip).not.toBeNull();
      expect(screen.getByText(copy.workspace.run.output)).toBeTruthy();
      expect(document.querySelector('[data-run-phase]')?.textContent).toBe(copy.workspace.run.starting);
      expect(loginTerminal.createLoginTerminal).toHaveBeenCalledWith('term:1', { screenReader: false });
      await waitFor(() => expect(registry.attachTerminal).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole('button', { name: copy.workspace.run.dismiss })).toBeNull();

      rerender(pane({ run: run() }));
      expect(document.querySelector('[data-run-phase]')?.textContent).toBe(copy.workspace.run.runningNoUrl);
      rerender(pane({ run: run({ url: 'http://localhost:5173' }) }));
      expect(document.querySelector('[data-run-phase]')?.textContent).toBe('Running · http://localhost:5173');
      // Same pty: the terminal is created once; the URL folded the strip, which detached the terminal.
      expect(loginTerminal.createLoginTerminal).toHaveBeenCalledTimes(1);

      const toggle = screen.getByRole('button', { name: copy.workspace.run.output });
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(document.querySelector('[data-run-terminal]')).toBeNull();
      expect(registry.detachTerminal).toHaveBeenCalledTimes(1);
      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(document.querySelector('[data-run-terminal]')).not.toBeNull();
      await waitFor(() => expect(registry.attachTerminal).toHaveBeenCalledTimes(2));
      fireEvent.click(toggle);
      expect(document.querySelector('[data-run-terminal]')).toBeNull();
      expect(registry.detachTerminal).toHaveBeenCalledTimes(2);
      // Collapsing keeps the entry: no dispose until the run goes away.
      expect(loginTerminal.disposeLoginTerminal).not.toHaveBeenCalled();
      // A device run reads the platform, never a URL.
      rerender(pane({ run: run({ platform: 'android', url: 'http://localhost:8081' }) }));
      expect(document.querySelector('[data-run-phase]')?.textContent).toBe('Running · Android');
    });

    it('the strip is open while the server comes up, folds once the app has a URL, and reopens when the run fails', async () => {
      const { rerender } = render(pane({ devUrl: null, run: run({ phase: 'starting' }) }));
      const toggle = () => screen.getByRole('button', { name: copy.workspace.run.output });
      expect(toggle().getAttribute('aria-expanded')).toBe('true');
      // The app is up: the strip gets out of the design window's way (it cannot float over a native view).
      rerender(pane({ devUrl: null, run: run({ url: 'http://localhost:5173' }) }));
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
      // The user's own toggle wins until the next transition.
      fireEvent.click(toggle());
      expect(toggle().getAttribute('aria-expanded')).toBe('true');
      rerender(pane({ devUrl: null, run: run({ url: 'http://localhost:5173', phase: 'running' }) }));
      expect(toggle().getAttribute('aria-expanded')).toBe('true');
      fireEvent.click(toggle());
      // A failure reopens it: the output is the only explanation.
      rerender(
        pane({
          devUrl: null,
          run: run({
            url: 'http://localhost:5173',
            phase: 'exited',
            exitCode: 1,
            endedAt: fixtures.DEMO_NOW,
          }),
        }),
      );
      expect(toggle().getAttribute('aria-expanded')).toBe('true');
      // A fresh run starts the cycle again.
      rerender(pane({ devUrl: null, run: run({ runId: 'run:2', terminalId: 'term:2', phase: 'starting' }) }));
      expect(toggle().getAttribute('aria-expanded')).toBe('true');
    });

    it('after exit: the code, a Dismiss link that clears the run, Run locally back on', async () => {
      const { rerender } = render(
        pane({ run: run({ phase: 'exited', exitCode: 1, endedAt: fixtures.DEMO_NOW }) }),
      );
      expect(document.querySelector('[data-run-phase]')?.textContent).toBe('Exited · code 1');
      expect(screen.getByRole('button', { name: /Run locally/ })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: copy.workspace.run.dismiss }));
      expect(of('run.dismiss')).toEqual([{ projectId: acme }]);
      rerender(pane({ run: null }));
      expect(document.querySelector('[data-run-strip]')).toBeNull();
      expect(loginTerminal.disposeLoginTerminal).toHaveBeenCalledTimes(1);
    });

    it('the run URL fills an empty URL field; a URL the user already has stays', async () => {
      const { rerender } = render(pane({ devUrl: null, run: run() }));
      const field = screen.getByLabelText(copy.workspace.design.urlLabel) as HTMLInputElement;
      expect(field.value).toBe('');
      rerender(pane({ devUrl: null, run: run({ url: 'http://localhost:5173' }) }));
      expect(field.value).toBe('http://localhost:5173');
      // Main saves it as devUrl; the re-seed keeps the same value and the view shows.
      rerender(pane({ devUrl: 'http://localhost:5173', run: run({ url: 'http://localhost:5173' }) }));
      expect(field.value).toBe('http://localhost:5173');
      await waitFor(() =>
        expect(sets().at(-1)).toMatchObject({ visible: true, url: 'http://localhost:5173' }),
      );

      cleanup();
      commands.length = 0;
      render(pane({ devUrl: 'localhost:8080', run: run({ url: 'http://localhost:5173' }) }));
      expect((screen.getByLabelText(copy.workspace.design.urlLabel) as HTMLInputElement).value).toBe(
        'localhost:8080',
      );
    });

    it('the native view is measured from the hole even with the strip open', async () => {
      render(pane({ run: run() }));
      await waitFor(() => expect(sets().length).toBeGreaterThan(0));
      expect(sets().at(-1)).toMatchObject({
        visible: true,
        bounds: { x: 220, y: 80, width: 900, height: 600 },
      });
      expect(document.querySelector('[data-preview-hole]')).not.toBeNull();
    });
  });

  describe('simulator', () => {
    const chips = () =>
      [...document.querySelectorAll('[data-run-platforms] [role="radio"]')] as HTMLButtonElement[];

    it('a web project has no platform chips and no device picker', async () => {
      render(pane({ devUrl: null }));
      await waitFor(() => expect(of('run.detect')).toHaveLength(1));
      expect(chips()).toHaveLength(0);
      expect(document.querySelector('[data-device-pick]')).toBeNull();
      expect(of('device.tooling')).toHaveLength(0);
      expect(document.querySelectorAll('[data-preview-device]')).toHaveLength(3);
    });

    it('a mobile project: Runs on chips with the detected platform selected; choosing one saves devPlatform', async () => {
      platforms = ['ios', 'android', 'web'];
      const { rerender } = render(pane({ devUrl: null }));
      await waitFor(() => expect(chips()).toHaveLength(3));
      const group = screen.getByRole('radiogroup', { name: copy.workspace.device.platformLabel });
      expect(group.contains(chips()[0]!)).toBe(true);
      expect(chips().map((c) => c.textContent)).toEqual(
        (['ios', 'android', 'web'] as const).map((p) => copy.workspace.device.platforms[p]),
      );
      expect(chips().map((c) => c.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
      expect(chips()[0]!.getAttribute('data-on')).toBe('true');
      expect(chips()[0]!.textContent).toBe(copy.workspace.device.platforms.ios);
      // A device platform: no web presets, the device hint, the device empty state, no page.
      expect(document.querySelectorAll('[data-preview-device]')).toHaveLength(0);
      expect(document.querySelector('[data-run-first-time]')?.textContent).toBe(
        copy.workspace.run.firstTimeDevice,
      );
      expect(screen.getByText(copy.workspace.device.empty)).toBeTruthy();
      await waitFor(() => expect(sets().at(-1)).toMatchObject({ visible: false, url: '' }));
      fireEvent.click(chips()[1]!);
      expect(of('project.settings.set')).toEqual([{ projectId: acme, patch: { devPlatform: 'android' } }]);
      // Main saved it: android is now the selection; web clears the setting (detection's first is the default).
      rerender(pane({ devUrl: null, devPlatform: 'android' }));
      expect(chips().map((c) => c.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
      fireEvent.click(chips()[2]!);
      expect(of('project.settings.set').at(-1)).toEqual({ projectId: acme, patch: { devPlatform: null } });
      // Clicking the current one is a no-op.
      fireEvent.click(chips()[1]!);
      expect(of('project.settings.set')).toHaveLength(2);
      // Web selected: the presets and the page come back, with the web first-time hint.
      rerender(pane({ devUrl: 'localhost:3000', devPlatform: 'web' }));
      expect(document.querySelectorAll('[data-preview-device]')).toHaveLength(3);
      await waitFor(() => expect(sets().at(-1)).toMatchObject({ visible: true, url: 'localhost:3000' }));
      expect(document.querySelector('[data-run-first-time]')?.textContent).toBe(
        fill(copy.workspace.run.firstTime, { agent: defaultAgent() }),
      );
    });

    it('the device picker lists the simulators once by name and saves devDevice', async () => {
      platforms = ['ios'];
      devices = sims;
      const { rerender } = render(pane({ devUrl: null }));
      await waitFor(() => expect(of('device.list')).toEqual([{ platform: 'ios' }]));
      const pick = (await screen.findByLabelText(copy.workspace.device.pick)) as HTMLSelectElement;
      expect(pick.hasAttribute('data-device-pick')).toBe(true);
      await waitFor(() => expect(pick.options.length).toBe(3));
      expect([...pick.options].map((o) => o.textContent)).toEqual([
        copy.workspace.device.pickAny,
        'iPhone 17 Pro · iOS 26.5',
        'iPad Air · iOS 26.5',
      ]);
      expect(pick.value).toBe('');
      fireEvent.change(pick, { target: { value: 'iPad Air' } });
      expect(of('project.settings.set')).toEqual([{ projectId: acme, patch: { devDevice: 'iPad Air' } }]);
      rerender(pane({ devUrl: null, devDevice: 'iPad Air' }));
      expect(pick.value).toBe('iPad Air');
      fireEvent.change(pick, { target: { value: '' } });
      expect(of('project.settings.set').at(-1)).toEqual({ projectId: acme, patch: { devDevice: null } });
      // A remembered device this machine does not have still shows, so the setting can be seen and changed.
      rerender(pane({ devUrl: null, devDevice: 'Pixel 8' }));
      expect(pick.value).toBe('Pixel 8');
      expect(pick.options.length).toBe(4);
    });

    it('missing tooling replaces the picker with the message; the hole says what to install', async () => {
      platforms = ['android'];
      tooling = { ...tooling, android: false };
      render(pane({ devUrl: null }));
      await waitFor(() =>
        expect(document.querySelector('[data-device-no-tooling="android"]')?.textContent).toBe(
          copy.workspace.device.noToolingAndroid,
        ),
      );
      expect(document.querySelector('[data-device-pick]')).toBeNull();
      expect(of('device.list')).toHaveLength(0);
      const empty = document.querySelector('[data-device-empty="android"]');
      expect(empty?.textContent).toContain(copy.workspace.device.noToolingAndroid);
      expect(empty?.textContent).toContain(copy.workspace.device.noToolingAndroidHint);
    });

    it('Run locally sends the platform, and the command field reads the platform placeholder', async () => {
      platforms = ['ios'];
      render(pane({ devUrl: null, devCommand: 'npx expo run:ios' }));
      await waitFor(() => expect(chips()).toHaveLength(1));
      const field = screen.getByLabelText(copy.workspace.run.command);
      expect(field.getAttribute('placeholder')).toBe(copy.workspace.run.commandPlaceholderIos);
      fireEvent.click(screen.getByRole('button', { name: /Run locally/ }));
      expect(of('run.start')).toEqual([{ projectId: acme, command: 'npx expo run:ios', platform: 'ios' }]);
      cleanup();
      commands.length = 0;
      platforms = ['android'];
      render(pane({ devUrl: null, devCommand: 'npx expo run:android' }));
      await waitFor(() => expect(chips()).toHaveLength(1));
      expect(screen.getByLabelText(copy.workspace.run.command).getAttribute('placeholder')).toBe(
        copy.workspace.run.commandPlaceholderAndroid,
      );
      fireEvent.keyDown(screen.getByLabelText(copy.workspace.run.command), { key: 'Enter' });
      expect(of('run.start')).toEqual([
        { projectId: acme, command: 'npx expo run:android', platform: 'android' },
      ]);
    });

    it('the device row: booting, ready with its mirror mode and actions, failed with the error, stopped', async () => {
      platforms = ['ios'];
      const { rerender } = render(pane({ devUrl: null, device: device({ phase: 'booting' }) }));
      const row = () => document.querySelector('[data-device-row]') as HTMLElement;
      expect(row().getAttribute('data-device-phase')).toBe('booting');
      expect(row().textContent).toContain('Booting iPhone 17 Pro…');
      expect(row().querySelector('[data-tone="accent"]')).not.toBeNull();
      expect(row().querySelector('[data-device-focus]')).toBeNull();
      // The hole already shows the phone, with the booting word on its screen.
      expect(screen.getByRole('group', { name: 'iPhone 17 Pro frame' })).toBeTruthy();
      expect(document.querySelector('[data-device-booting]')?.textContent).toBe('Booting iPhone 17 Pro…');
      expect(document.querySelector('[data-device-frame]')).toBeNull();
      expect(of('device.mirror')).toHaveLength(0);

      rerender(pane({ devUrl: null, device: device() }));
      expect(row().getAttribute('data-device-phase')).toBe('ready');
      await waitFor(() => expect(of('device.mirror')).toEqual([{ projectId: acme }]));
      await waitFor(() =>
        expect(row().querySelector('[data-device-text]')?.textContent).toBe(
          'Mirroring · iPhone 17 Pro · screenshots',
        ),
      );
      fireEvent.click(row().querySelector('[data-device-focus]')!);
      expect(of('device.focus')).toEqual([{ projectId: acme }]);
      fireEvent.click(row().querySelector('[data-device-shutdown]')!);
      expect(of('device.stop')).toEqual([{ projectId: acme, shutdown: true }]);
      fireEvent.click(row().querySelector('[data-device-stop]')!);
      expect(of('device.stop').at(-1)).toEqual({ projectId: acme, shutdown: false });
      expect(row().querySelector('[data-device-stop]')?.textContent).toBe(copy.workspace.device.stop);

      rerender(pane({ devUrl: null, device: device({ phase: 'failed', error: 'simctl boot exited 1' }) }));
      expect(row().getAttribute('data-device-phase')).toBe('failed');
      expect(row().querySelector('[data-device-text]')?.textContent).toBe(
        'Simulator failed: simctl boot exited 1',
      );
      expect(row().querySelector('[data-device-focus]')).toBeNull();
      expect(row().querySelector('[data-device-stop]')).not.toBeNull();
      expect(screen.queryByRole('group', { name: /frame$/ })).toBeNull();
      expect(screen.getByText(copy.workspace.device.empty)).toBeTruthy();

      rerender(pane({ devUrl: null, device: device({ phase: 'stopped' }) }));
      expect(row().querySelector('[data-device-text]')?.textContent).toBe(copy.workspace.device.stopped);
      expect(row().querySelector('[data-device-stop]')?.textContent).toBe(copy.workspace.run.dismiss);

      rerender(pane({ devUrl: null, device: null }));
      expect(document.querySelector('[data-device-row]')).toBeNull();
    });

    it('while a device is ready the web view is hidden and the frame shows screenshots, swapping src on device.frame', async () => {
      // Even with a page to show: the simulator has the hole.
      render(pane({ devUrl: 'localhost:3000', device: device() }));
      await waitFor(() => expect(sets().length).toBeGreaterThan(0));
      expect(sets().at(-1)).toMatchObject({ visible: false });
      const frame = await waitFor(() => {
        const el = document.querySelector('[data-device-frame]');
        expect(el?.getAttribute('data-mirror')).toBe('screenshots');
        return el as HTMLElement;
      });
      // The frame takes the device's own screen for its aspect.
      const group = screen.getByRole('group', { name: 'iPhone 17 Pro frame' });
      expect((group.querySelector('[data-screen]') as HTMLElement).style.width).toBe('1179px');
      expect((group.querySelector('[data-screen]') as HTMLElement).style.height).toBe('2556px');
      // No frame yet: nothing to fetch.
      expect(frame.querySelector('[data-device-image]')).toBeNull();
      emit('device.frame', { projectId: acme, seq: 1 });
      const img = () => frame.querySelector('[data-device-image]') as HTMLImageElement;
      expect(img().getAttribute('src')).toBe(`styx-device://frame/${acme}?seq=1`);
      emit('device.frame', { projectId: acme, seq: 2 });
      expect(img().getAttribute('src')).toBe(`styx-device://frame/${acme}?seq=2`);
      // Another project's frames are not ours.
      emit('device.frame', { projectId: fixtures.ids.project.blogV2, seq: 9 });
      expect(img().getAttribute('src')).toBe(`styx-device://frame/${acme}?seq=2`);
      expect(document.querySelector('[data-device-screen-access]')).toBeNull();
    });

    it('no picture: the frame says why; a Screen Recording reason adds the notice and its link', async () => {
      mirrorAnswer = { mode: 'screenshots', reason: 'Screen Recording is not granted to Styx' };
      render(pane({ devUrl: null, device: device() }));
      const link = await screen.findByRole('button', { name: copy.workspace.device.screenAccessOpen });
      expect(link.hasAttribute('data-device-screen-access')).toBe(true);
      expect(screen.getByText(copy.workspace.device.screenAccess)).toBeTruthy();
      fireEvent.click(link);
      expect(of('device.openScreenAccess')).toEqual([{}]);

      cleanup();
      mirrorAnswer = { mode: 'none', reason: 'the simulator window was not found' };
      render(pane({ devUrl: null, device: device({ mirror: 'none' }) }));
      await waitFor(() =>
        expect(document.querySelector('[data-device-frame]')?.getAttribute('data-mirror')).toBe('none'),
      );
      expect(document.querySelector('[data-device-no-picture]')?.textContent).toContain(
        'the simulator window was not found',
      );
      expect(document.querySelector('[data-device-text]')?.textContent).toBe(
        'Mirroring · iPhone 17 Pro · no picture',
      );
    });

    it('live: takes the one window main armed as a stream; when it ends, main is asked again', async () => {
      mirrorAnswer = { mode: 'window', reason: null };
      const stream = fakeStream();
      const getDisplayMedia = vi.fn(async () => stream);
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getDisplayMedia },
      });
      try {
        render(pane({ devUrl: null, device: device({ mirror: 'window' }) }));
        await waitFor(() => expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false }));
        const video = await waitFor(() => {
          const v = document.querySelector('[data-device-video]') as HTMLVideoElement & {
            srcObject: unknown;
          };
          expect(v.srcObject).toBe(stream);
          return v;
        });
        expect(video.muted).toBe(true);
        expect(video.autoplay).toBe(true);
        expect(document.querySelector('[data-device-frame]')?.getAttribute('data-mirror')).toBe('window');
        expect(document.querySelector('[data-device-text]')?.textContent).toBe(
          'Mirroring · iPhone 17 Pro · live',
        );
        expect(of('device.mirror')).toHaveLength(1);
        // The simulator window went away: ask main to arm it again (it may answer screenshots now).
        mirrorAnswer = { mode: 'screenshots', reason: null };
        act(() => {
          stream.dispatchEvent(new Event('inactive'));
        });
        await waitFor(() => expect(of('device.mirror')).toHaveLength(2));
        await waitFor(() =>
          expect(document.querySelector('[data-device-frame]')?.getAttribute('data-mirror')).toBe(
            'screenshots',
          ),
        );
        expect(getDisplayMedia).toHaveBeenCalledTimes(1);
      } finally {
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
      }
    });

    it('leaving the pane stops the capture', async () => {
      mirrorAnswer = { mode: 'window', reason: null };
      const stream = fakeStream();
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getDisplayMedia: vi.fn(async () => stream) },
      });
      try {
        const { unmount } = render(pane({ devUrl: null, device: device({ mirror: 'window' }) }));
        await waitFor(() => expect(document.querySelector('[data-device-video]')).not.toBeNull());
        unmount();
        expect(stream.track.stop).toHaveBeenCalled();
      } finally {
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
      }
    });

    it('input: taps and swipes are mapped to the device screen; keys go by name, typing is batched', async () => {
      render(pane({ devUrl: null, device: device() }));
      emit('device.frame', { projectId: acme, seq: 1 });
      const surface = await waitFor(() => {
        const el = document.querySelector('[data-device-surface]') as HTMLElement;
        expect(el).not.toBeNull();
        return el;
      });
      // An application region: assistive tech passes keys through, and the description says where they go.
      expect(surface.getAttribute('role')).toBe('application');
      expect(surface.getAttribute('aria-roledescription')).toBe(copy.workspace.device.surfaceRole);
      expect(surface.getAttribute('aria-label')).toBe('Screen of iPhone 17 Pro');
      expect(document.getElementById(surface.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
        copy.workspace.device.surfaceHint,
      );
      expect(surface.getAttribute('tabindex')).toBe('0');
      expect(surface.getAttribute('data-device-input')).toBe('true');
      expect(document.querySelector('[data-device-image]')?.getAttribute('aria-hidden')).toBe('true');
      // The surface is 393×852 on screen at (100, 50); the device is 1179×2556: a tap at its centre.
      fireEvent.pointerDown(surface, { clientX: 100 + 196.5, clientY: 50 + 426, button: 0 });
      fireEvent.pointerUp(surface, { clientX: 100 + 196.5, clientY: 50 + 426, button: 0 });
      fireEvent.click(surface, { clientX: 100 + 196.5, clientY: 50 + 426 });
      expect(of('device.input')).toEqual([{ projectId: acme, event: { kind: 'tap', x: 590, y: 1278 } }]);
      // A click on its own (keyboard activation, synthetic) still taps.
      fireEvent.click(surface, { clientX: 100, clientY: 50 });
      expect(of('device.input').at(-1)).toEqual({ projectId: acme, event: { kind: 'tap', x: 0, y: 0 } });
      // Moving more than 8 px is a swipe, from the press to the release.
      fireEvent.pointerDown(surface, { clientX: 110, clientY: 500, button: 0 });
      fireEvent.pointerUp(surface, { clientX: 300, clientY: 500, button: 0 });
      fireEvent.click(surface, { clientX: 300, clientY: 500 });
      const swipe = of('device.input').at(-1) as { event: Record<string, number | string> };
      expect(swipe.event).toMatchObject({ kind: 'swipe', x1: 30, y1: 1350, x2: 600, y2: 1350 });
      expect(swipe.event['durationMs']).toBeGreaterThanOrEqual(1);
      expect(of('device.input')).toHaveLength(3);
      // Named keys go at once; characters wait for 300 ms of idle and go as one text.
      fireEvent.keyDown(surface, { key: 'Enter' });
      expect(of('device.input').at(-1)).toEqual({ projectId: acme, event: { kind: 'key', key: 'enter' } });
      fireEvent.keyDown(surface, { key: 'h' });
      fireEvent.keyDown(surface, { key: 'i' });
      expect(of('device.input')).toHaveLength(4);
      await waitFor(() =>
        expect(of('device.input').at(-1)).toEqual({ projectId: acme, event: { kind: 'text', text: 'hi' } }),
      );
      // A named key flushes what was typed before it, in order.
      fireEvent.keyDown(surface, { key: 'x' });
      fireEvent.keyDown(surface, { key: 'Backspace' });
      expect(of('device.input').slice(-2)).toEqual([
        { projectId: acme, event: { kind: 'text', text: 'x' } },
        { projectId: acme, event: { kind: 'key', key: 'backspace' } },
      ]);
      // Shortcuts are not typing.
      fireEvent.keyDown(surface, { key: 'k', metaKey: true });
      fireEvent.keyDown(surface, { key: 'Tab' });
      expect(of('device.input')).toHaveLength(7);
      expect(document.querySelector('[data-device-no-input]')).toBeNull();
    });

    it('without an input bridge the picture is plain, a row explains (iOS words, Android words) and Open the simulator is described by it', async () => {
      const { rerender } = render(pane({ devUrl: null, device: device({ input: false }) }));
      emit('device.frame', { projectId: acme, seq: 1 });
      const surface = await waitFor(() => {
        const el = document.querySelector('[data-device-surface]') as HTMLElement;
        expect(el).not.toBeNull();
        return el;
      });
      expect(surface.getAttribute('role')).toBe('img');
      expect(surface.hasAttribute('tabindex')).toBe(false);
      expect(surface.getAttribute('data-device-input')).toBe('false');
      fireEvent.pointerDown(surface, { clientX: 150, clientY: 150, button: 0 });
      fireEvent.pointerUp(surface, { clientX: 150, clientY: 150, button: 0 });
      fireEvent.click(surface, { clientX: 150, clientY: 150 });
      fireEvent.keyDown(surface, { key: 'a' });
      expect(of('device.input')).toHaveLength(0);
      // The explanation is a row that stays (no click, no timer), and the row's action is described by it.
      const row = document.querySelector('[data-device-no-input]') as HTMLElement;
      expect(row.textContent).toContain(copy.workspace.device.noInputIos);
      const focus = document.querySelector('[data-device-row] [data-device-focus]') as HTMLElement;
      expect(document.getElementById(focus.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
        copy.workspace.device.noInputIos,
      );
      fireEvent.click(focus);
      expect(of('device.focus')).toEqual([{ projectId: acme }]);

      rerender(
        pane({ devUrl: null, device: device({ input: false, platform: 'android', deviceName: 'Pixel 8' }) }),
      );
      expect(document.querySelector('[data-device-no-input]')?.textContent).toContain(
        copy.workspace.device.noInput,
      );
      // With a bridge there is nothing to explain.
      rerender(pane({ devUrl: null, device: device({ input: true }) }));
      expect(document.querySelector('[data-device-no-input]')).toBeNull();
    });
  });
});

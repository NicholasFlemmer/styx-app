// @vitest-environment jsdom
import { copy, fixtures, type DevRun } from '@styx/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const run = (over: Partial<DevRun> = {}): DevRun => ({
  projectId: acme,
  runId: 'run:1',
  terminalId: 'term:1',
  command: 'pnpm dev',
  phase: 'running',
  url: null,
  exitCode: null,
  startedAt: fixtures.DEMO_NOW - 5_000,
  endedAt: null,
  ...over,
});

const pane = (props: Partial<Parameters<typeof DesignPane>[0]> = {}) => (
  <DesignPane projectId={acme} devUrl="localhost:3000" active run={null} devCommand={null} {...props} />
);

describe('DesignPane', () => {
  beforeEach(() => {
    commands.length = 0;
    suggestions = [{ command: 'pnpm dev', source: 'package.json' }];
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
          if (name === 'run.detect') return { ok: true, value: { suggestions } };
          return { ok: true, value: {} };
        }),
      },
    });
    // jsdom has no layout engine, so give the measured hole a size.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 220,
      y: 80,
      left: 220,
      top: 80,
      width: 900,
      height: 600,
      right: 1120,
      bottom: 680,
      toJSON: () => ({}),
    } as DOMRect);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({ overlays: [], screen: 'workspace', platform: 'darwin', projectId: acme });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
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

  it('a device preset re-reports without touching the saved URL', async () => {
    render(pane());
    await waitFor(() => expect(sets().length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: copy.workspace.design.devices.phone }));
    await waitFor(() => expect(sets().at(-1)).toMatchObject({ device: 'phone', visible: true }));
    expect(of('project.settings.set')).toHaveLength(0);
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
    it('seeds the command from run.detect when nothing is saved, and says where it came from', async () => {
      render(pane({ devUrl: null }));
      expect(of('run.detect')).toEqual([{ projectId: acme }]);
      const field = screen.getByLabelText(copy.workspace.run.command) as HTMLInputElement;
      await waitFor(() => expect(field.value).toBe('pnpm dev'));
      expect(field.getAttribute('title')).toBe('Detected from package.json');
      expect(field.getAttribute('placeholder')).toBe(copy.workspace.run.commandPlaceholder);
      expect(screen.queryByTestId('run-strip')).toBeNull();
      expect(document.querySelector('[data-run-strip]')).toBeNull();
    });

    it('a saved devCommand wins over the suggestion, with no "detected" title', async () => {
      render(pane({ devCommand: 'make dev' }));
      const field = screen.getByLabelText(copy.workspace.run.command) as HTMLInputElement;
      await waitFor(() => expect(of('run.detect')).toHaveLength(1));
      expect(field.value).toBe('make dev');
      expect(field.getAttribute('title')).toBeNull();
    });

    it('with no suggestion and nothing saved the field is empty and Run is disabled', async () => {
      suggestions = [];
      render(pane());
      await waitFor(() => expect(of('run.detect')).toHaveLength(1));
      const field = screen.getByLabelText(copy.workspace.run.command) as HTMLInputElement;
      expect(field.value).toBe('');
      const button = screen.getByRole('button', { name: /Run locally/ });
      expect(button.hasAttribute('disabled')).toBe(true);
      fireEvent.click(button);
      expect(of('run.start')).toEqual([]);
    });

    it('Run locally and Enter in the command field both start the run with the command shown', async () => {
      render(pane({ devCommand: 'pnpm dev' }));
      fireEvent.click(screen.getByRole('button', { name: /Run locally/ }));
      expect(of('run.start')).toEqual([{ projectId: acme, command: 'pnpm dev' }]);
      const field = screen.getByLabelText(copy.workspace.run.command);
      fireEvent.change(field, { target: { value: '  npm run dev  ' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(of('run.start').at(-1)).toEqual({ projectId: acme, command: 'npm run dev' });
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
      expect(loginTerminal.createLoginTerminal).toHaveBeenCalledWith('term:1');
      await waitFor(() => expect(registry.attachTerminal).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole('button', { name: copy.workspace.run.dismiss })).toBeNull();

      rerender(pane({ run: run() }));
      expect(document.querySelector('[data-run-phase]')?.textContent).toBe(copy.workspace.run.runningNoUrl);
      rerender(pane({ run: run({ url: 'http://localhost:5173' }) }));
      expect(document.querySelector('[data-run-phase]')?.textContent).toBe('Running · http://localhost:5173');
      // Same pty: the terminal is created once and stays attached.
      expect(loginTerminal.createLoginTerminal).toHaveBeenCalledTimes(1);

      const toggle = screen.getByRole('button', { name: copy.workspace.run.output });
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(document.querySelector('[data-run-terminal]')).toBeNull();
      expect(registry.detachTerminal).toHaveBeenCalledTimes(1);
      fireEvent.click(toggle);
      expect(document.querySelector('[data-run-terminal]')).not.toBeNull();
      await waitFor(() => expect(registry.attachTerminal).toHaveBeenCalledTimes(2));
      // Collapsing keeps the entry: no dispose until the run goes away.
      expect(loginTerminal.disposeLoginTerminal).not.toHaveBeenCalled();
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
});

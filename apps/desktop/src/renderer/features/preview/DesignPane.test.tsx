// @vitest-environment jsdom
import { copy, fixtures } from '@styx/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { DesignPane } from './DesignPane';

const acme = fixtures.ids.project.acmeShop;
const commands: { name: string; input: unknown }[] = [];
const sets = () =>
  commands.filter((c) => c.name === 'preview.set').map((c) => c.input as Record<string, unknown>);

describe('DesignPane', () => {
  beforeEach(() => {
    commands.length = 0;
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: fixtures.DEMO_NOW },
        command: vi.fn(async (name: string, input: unknown) => {
          commands.push({ name, input });
          return { ok: true, value: {} };
        }),
      },
    });
    // jsdom has no layout engine, so give the measured hole a size.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 220, y: 80, left: 220, top: 80, width: 900, height: 600, right: 1120, bottom: 680, toJSON: () => ({}),
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
    render(<DesignPane projectId={acme} devUrl="localhost:3000" active />);
    await waitFor(() => expect(sets().length).toBeGreaterThan(0));
    expect(sets()[0]).toMatchObject({
      visible: true,
      url: 'localhost:3000',
      device: 'desktop',
      bounds: { x: 220, y: 80, width: 900, height: 600 },
    });
  });

  it('hides while an overlay is open: a native view paints above the DOM', async () => {
    render(<DesignPane projectId={acme} devUrl="localhost:3000" active />);
    await waitFor(() => expect(sets().length).toBeGreaterThan(0));
    commands.length = 0;
    useUiStore.setState({ overlays: [{ id: 'o1', kind: 'modal', modal: 'spawn', projectId: acme }] });
    await waitFor(() => expect(sets().at(-1)).toMatchObject({ visible: false }));
  });

  it('stays hidden with no URL, and shows the hint instead', async () => {
    render(<DesignPane projectId={acme} devUrl={null} active />);
    await waitFor(() => expect(sets().length).toBeGreaterThan(0));
    expect(sets().at(-1)).toMatchObject({ visible: false });
    expect(screen.getByText(copy.workspace.design.empty)).toBeTruthy();
  });

  it('hides when the Code tab is showing rather than sitting behind the editor', async () => {
    render(<DesignPane projectId={acme} devUrl="localhost:3000" active={false} />);
    await waitFor(() => expect(sets().length).toBeGreaterThan(0));
    expect(sets().at(-1)).toMatchObject({ visible: false });
  });

  it('a device preset re-reports without touching the saved URL', async () => {
    render(<DesignPane projectId={acme} devUrl="localhost:3000" active />);
    await waitFor(() => expect(sets().length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: copy.workspace.design.devices.phone }));
    await waitFor(() => expect(sets().at(-1)).toMatchObject({ device: 'phone', visible: true }));
    expect(commands.filter((c) => c.name === 'project.settings.set')).toHaveLength(0);
  });

  it('Enter in the URL field saves it to the project settings', async () => {
    render(<DesignPane projectId={acme} devUrl={null} active />);
    const field = screen.getByLabelText(copy.workspace.design.urlLabel);
    fireEvent.change(field, { target: { value: 'localhost:5173' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(commands.filter((c) => c.name === 'project.settings.set')).toEqual([
      { name: 'project.settings.set', input: { projectId: acme, patch: { devUrl: 'localhost:5173' } } },
    ]);
  });

  it('unmounting detaches the view', async () => {
    const { unmount } = render(<DesignPane projectId={acme} devUrl="localhost:3000" active />);
    await waitFor(() => expect(sets().length).toBeGreaterThan(0));
    commands.length = 0;
    unmount();
    expect(sets().at(-1)).toMatchObject({ visible: false, url: '' });
  });
});

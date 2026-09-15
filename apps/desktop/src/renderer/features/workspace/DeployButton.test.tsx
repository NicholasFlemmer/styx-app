// @vitest-environment jsdom
import { copy, fixtures, removeRows, type Deploy, type ReadModel } from '@styx/core';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { DeployButton } from './DeployButton';

const { ids, DEMO_NOW } = fixtures;
const acme = ids.project.acmeShop;

const running = (over: Partial<Deploy> = {}): Deploy => ({
  deployId: 'dep:1',
  targetId: ids.target.vercelProd,
  projectId: acme,
  phase: 'running',
  terminalId: 'term:1',
  exitCode: null,
  error: null,
  startedAt: DEMO_NOW - 60_000,
  endedAt: null,
  ...over,
});

/** Demo model with a second prod Vercel target on acme-shop (→ picker). */
const twoProd = (): ReadModel => {
  const m = fixtures.demoReadModel();
  const prod = m.targets.byId[ids.target.vercelProd];
  if (prod === undefined) throw new Error('fixture');
  const second = { ...prod, id: 'target:second' as typeof prod.id, name: 'Vercel EU' };
  return {
    ...m,
    targets: { byId: { ...m.targets.byId, [second.id]: second }, ids: [...m.targets.ids, second.id] },
  };
};

const modals = () => useUiStore.getState().overlays.filter((o) => o.kind === 'modal');

describe('DeployButton', () => {
  beforeEach(() => {
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: DEMO_NOW },
        command: vi.fn(async () => ({ ok: true, value: {} })),
      },
    });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({ overlays: [], screen: 'workspace', platform: 'darwin', projectId: acme });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('names the prod target and starts a deploy for it', () => {
    render(<DeployButton projectId={acme} />);
    const button = screen.getByRole('button', { name: /Deploy to live · Vercel prod/ });
    expect(button.getAttribute('disabled')).toBeNull();
    expect(button.textContent).toBe('▲Deploy to live · Vercel prod');
    fireEvent.click(button);
    expect(modals()).toEqual([
      expect.objectContaining({ kind: 'modal', modal: 'deploy', targetId: ids.target.vercelProd }),
    ]);
    expect((modals()[0] as { deployId?: string }).deployId).toBeUndefined();
  });

  it('targets without a deploy verb or command: an enabled "Set up deploy" that opens the setup modal', () => {
    render(<DeployButton projectId={ids.project.infraTools} />);
    const button = screen.getByRole('button', { name: copy.deploy.setup });
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    expect(modals()).toEqual([
      expect.objectContaining({ kind: 'modal', modal: 'deploy-setup', projectId: ids.project.infraTools }),
    ]);
  });

  it('no targets at all: an enabled "Connect a deploy target" that opens the connect modal', () => {
    const m = fixtures.demoReadModel();
    useReadModel
      .getState()
      .replaceModel(
        { ...m, targets: removeRows(m.targets, [ids.target.infraAws, ids.target.infraGcp]) },
        'connected',
      );
    render(<DeployButton projectId={ids.project.infraTools} />);
    const button = screen.getByRole('button', { name: copy.deploy.noTarget });
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    expect(modals()).toEqual([
      expect.objectContaining({ kind: 'modal', modal: 'connect', projectId: ids.project.infraTools }),
    ]);
  });

  it('only non-prod deployables: the plain secondary "Deploy · Vercel preview"', () => {
    const m = fixtures.demoReadModel();
    useReadModel
      .getState()
      .replaceModel({ ...m, targets: removeRows(m.targets, [ids.target.vercelProd]) }, 'connected');
    render(<DeployButton projectId={acme} />);
    const button = screen.getByRole('button', { name: /Deploy · Vercel preview/ });
    expect(button.getAttribute('data-on')).toBeNull();
    fireEvent.click(button);
    expect(modals()[0]).toMatchObject({ modal: 'deploy', targetId: ids.target.vercelPreview });
  });

  it('while a deploy runs it reports the target with a dot, and click re-opens that deploy', () => {
    const m = fixtures.demoReadModel();
    useReadModel.getState().replaceModel({ ...m, deploys: { 'dep:1': running() } }, 'connected');
    render(<DeployButton projectId={acme} />);
    const button = screen.getByRole('button', { name: /Deploying · Vercel prod…/ });
    expect(button.querySelector('[data-dot]') ?? button.querySelector('span')).not.toBeNull();
    fireEvent.click(button);
    expect(modals()[0]).toMatchObject({
      modal: 'deploy',
      targetId: ids.target.vercelProd,
      deployId: 'dep:1',
    });
  });

  describe('several prod targets → picker', () => {
    beforeEach(() => useReadModel.getState().replaceModel(twoProd(), 'connected'));

    it('opens a menu with a heading and one row per target; choosing starts that target', () => {
      render(<DeployButton projectId={acme} />);
      const button = screen.getByRole('button', { name: /^Deploy to$/ });
      expect(button.getAttribute('aria-haspopup')).toBe('menu');
      expect(button.getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(button);
      const menu = screen.getByRole('menu', { name: copy.deploy.pick });
      expect(menu.textContent?.startsWith(copy.deploy.pick)).toBe(true);
      const items = within(menu).getAllByRole('menuitem');
      expect(items.map((i) => i.textContent)).toEqual(['Vercel prod', 'Vercel EU prod']);
      expect(document.activeElement).toBe(items[0]);
      fireEvent.click(items[1] as HTMLElement);
      expect(screen.queryByRole('menu')).toBeNull();
      expect(modals()[0]).toMatchObject({ modal: 'deploy', targetId: 'target:second' });
      expect(document.activeElement).toBe(button);
    });

    it('arrow keys move, Escape closes and returns focus, an outside mousedown closes', () => {
      render(<DeployButton projectId={acme} />);
      const button = screen.getByRole('button', { name: /^Deploy to$/ });
      button.focus();
      fireEvent.keyDown(button, { key: 'ArrowDown' });
      const menu = screen.getByRole('menu');
      const items = within(menu).getAllByRole('menuitem');
      expect(document.activeElement).toBe(items[0]);
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(items[1]);
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(items[0]);
      fireEvent.keyDown(menu, { key: 'End' });
      expect(document.activeElement).toBe(items[1]);
      fireEvent.keyDown(menu, { key: 'Escape' });
      expect(screen.queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(button);
      expect(modals()).toEqual([]);

      fireEvent.click(button);
      expect(screen.getByRole('menu')).toBeTruthy();
      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole('menu')).toBeNull();
    });
  });
});

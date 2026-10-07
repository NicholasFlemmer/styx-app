// @vitest-environment jsdom
import { copy, fixtures, removeRows, type Deploy, type ReadModel, type Session } from '@styx/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

/** Demo acme-shop down to Vercel prod, a second prod Vercel target, Vercel preview and GitHub (→ a four-row picker). */
const twoProd = (): ReadModel => {
  const m = fixtures.demoReadModel();
  const prod = m.targets.byId[ids.target.vercelProd];
  if (prod === undefined) throw new Error('fixture');
  const second = { ...prod, id: 'target:second' as typeof prod.id, name: 'Vercel EU' };
  const targets = removeRows(m.targets, [ids.target.supabaseProd, ids.target.awsProd]);
  return {
    ...m,
    targets: { byId: { ...targets.byId, [second.id]: second }, ids: [...targets.ids, second.id] },
  };
};

/** The model plus a live session `id` (a copy of the demo Gemini session) on `projectId`. */
const withSession = (m: ReadModel, id: string, projectId: Session['projectId']): ReadModel => {
  const base = m.sessions.byId[ids.session.gemini];
  if (base === undefined) throw new Error('fixture');
  const sid = id as Session['id'];
  return {
    ...m,
    sessions: {
      byId: { ...m.sessions.byId, [sid]: { ...base, id: sid, projectId, state: 'working' } },
      ids: [...m.sessions.ids, sid],
    },
  };
};

const modals = () => useUiStore.getState().overlays.filter((o) => o.kind === 'modal');
const calls = (name: string) =>
  (vi.mocked(window.styx.command).mock.calls as [string, unknown][])
    .filter((c) => c[0] === name)
    .map((c) => c[1]);

describe('DeployButton', () => {
  beforeEach(() => {
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: DEMO_NOW },
        command: vi.fn(async (name: string) => {
          if (name === 'session.spawn') return { ok: true, value: { sessionId: 's-learn' } };
          if (name === 'deploy.detect')
            return { ok: true, value: { suggestions: [{ command: 'sam deploy', source: 'template.yaml' }] } };
          return { ok: true, value: {} };
        }),
      },
    });
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
    Object.assign(window, { styx: undefined });
  });

  it('one prod target: names it and starts a deploy for it', () => {
    const m = fixtures.demoReadModel();
    useReadModel
      .getState()
      .replaceModel(
        { ...m, targets: removeRows(m.targets, [ids.target.blogVercelPreview, ids.target.blogGithub]) },
        'connected',
      );
    render(<DeployButton projectId={ids.project.blogV2} />);
    const button = screen.getByRole('button', { name: /Deploy to live · Vercel prod/ });
    expect(button.getAttribute('disabled')).toBeNull();
    expect(button.textContent).toBe('▲Deploy to live · Vercel prod');
    expect(button.closest('[data-deploy-button]')?.getAttribute('data-learn')).toBeNull();
    fireEvent.click(button);
    expect(modals()).toEqual([
      expect.objectContaining({ kind: 'modal', modal: 'deploy', targetId: ids.target.blogVercel }),
    ]);
    expect((modals()[0] as { deployId?: string }).deployId).toBeUndefined();
  });

  it('a target Styx has no command for: the same button, and the click hands the first deploy to the agent', async () => {
    const m = fixtures.demoReadModel();
    useReadModel
      .getState()
      .replaceModel({ ...m, targets: removeRows(m.targets, [ids.target.infraGcp]) }, 'connected');
    render(<DeployButton projectId={ids.project.infraTools} />);
    const button = screen.getByRole('button', { name: /Deploy to live · AWS acme-prod prod/ });
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.closest('[data-deploy-button]')?.getAttribute('data-learn')).toBe('true');
    fireEvent.click(button);
    await waitFor(() => expect(calls('session.spawn')).toHaveLength(1));
    expect(modals()).toEqual([]);
    expect(calls('session.spawn')[0]).toMatchObject({
      projectId: ids.project.infraTools,
      toggles: { mayRequestTargets: true, autoApproveEdits: true },
    });
    const first = (calls('session.spawn')[0] as { firstMessage: string }).firstMessage;
    expect(first).toContain('AWS acme-prod prod');
    expect(first).toContain(`targetId "${ids.target.infraAws}"`);
    expect(first).toContain('`sam deploy` (from template.yaml)');
    // The chat opens on the new session, and the button reports who is on it until the session ends.
    const ui = useUiStore.getState();
    expect(ui.projectSession[ids.project.infraTools]).toBeUndefined();
    expect(ui.overlays).toContainEqual(
      expect.objectContaining({ kind: 'task', taskKey: `deploy:${ids.target.infraAws}` }),
    );
    expect(ui.learning[`deploy:${ids.target.infraAws}`]).toBe('s-learn');
    useReadModel
      .getState()
      .replaceModel(
        withSession(
          { ...m, targets: removeRows(m.targets, [ids.target.infraGcp]) },
          's-learn',
          ids.project.infraTools,
        ),
        'connected',
      );
    const learning = await screen.findByRole('button', {
      name: 'Deploying · AWS acme-prod prod',
    });
    useUiStore.setState({ projectSession: {} });
    fireEvent.click(learning);
    expect(useUiStore.getState().projectSession[ids.project.infraTools]).toBeUndefined();
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
    useReadModel.getState().replaceModel(
      {
        ...m,
        targets: removeRows(m.targets, [
          ids.target.vercelProd,
          ids.target.supabaseProd,
          ids.target.awsProd,
          ids.target.github,
        ]),
      },
      'connected',
    );
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

  it('issue #9: prod + staging → the click opens a picker (no deploy), staging first, prod below a rule', () => {
    render(<DeployButton projectId={ids.project.infraTools} />);
    const button = screen.getByRole('button', { name: /^Deploy to$/ });
    button.focus();
    fireEvent.keyDown(button, { key: 'ArrowDown' });
    expect(modals()).toEqual([]);
    expect(calls('session.spawn')).toEqual([]);
    const menu = screen.getByRole('menu', { name: copy.deploy.pick });
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['GCP infra staging', 'AWS acme-prod prod']);
    expect(items.map((i) => i.getAttribute('data-prod'))).toEqual([null, 'true']);
    // The first row a keyboard user lands on is never production.
    expect(document.activeElement).toBe(items[0]);
    // The rule sits between the two groups and is skipped by the arrow keys.
    const rule = within(menu).getByRole('separator');
    expect(rule.nextElementSibling).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(modals()).toEqual([]);
  });

  describe('several prod targets plus non-prod → picker with all of them', () => {
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
      expect(items.map((i) => i.textContent)).toEqual([
        'Vercel preview',
        'GitHub acme/shop scm',
        'Vercel prod',
        'Vercel EU prod',
      ]);
      expect(within(menu).getAllByRole('separator')).toHaveLength(1);
      expect(document.activeElement).toBe(items[0]);
      fireEvent.click(items[3] as HTMLElement);
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
      fireEvent.keyDown(menu, { key: 'End' });
      expect(document.activeElement).toBe(items[3]);
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(items[0]);
      fireEvent.keyDown(menu, { key: 'ArrowUp' });
      expect(document.activeElement).toBe(items[3]);
      fireEvent.keyDown(menu, { key: 'Home' });
      expect(document.activeElement).toBe(items[0]);
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

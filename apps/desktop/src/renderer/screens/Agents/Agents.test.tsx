// @vitest-environment jsdom
import { boardColumns, copy, fixtures, upsertRows, type ProjectId } from '@styx/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keys } from '../../keys';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { Agents, denyOptionOf } from './Agents';

const acme = fixtures.ids.project.acmeShop as ProjectId;
const commandMock = vi.fn(async () => ({ ok: true, value: {} }));

const column = (label: string) => within(screen.getByRole('region', { name: label }));

describe('Agents board', () => {
  beforeEach(() => {
    commandMock.mockClear();
    Object.assign(window, {
      styx: { platform: 'darwin', env: { now: fixtures.DEMO_NOW }, command: commandMock },
    });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({
      overlays: [],
      screen: 'agents',
      platform: 'darwin',
      projectId: acme,
      projectSession: {},
      boardScope: 'all',
    });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('renders the four columns from boardColumns with their counts, one line each, and per-state CTAs', () => {
    render(<Agents />);
    const expected = boardColumns(useReadModel.getState().model, fixtures.DEMO_NOW);
    for (const col of expected) {
      const region = column(col.label);
      expect(region.getByRole('heading', { level: 3 }).textContent).toBe(`${col.label}${col.items.length}`);
      expect(region.getByText(col.sub)).toBeTruthy();
      for (const card of col.items) {
        expect(region.getByText(`${card.project} · ${card.branch}`)).toBeTruthy();
        expect(region.getByText(card.note)).toBeTruthy();
      }
      expect(
        region.queryAllByRole('button', { name: /^(Open|Review grant|Review plan|Reopen)$/ }),
      ).toHaveLength(col.items.length);
      // Deny only on needs-you cards; Archive only on done cards.
      expect(region.queryAllByRole('button', { name: copy.board.actions.deny })).toHaveLength(
        col.key === 'needs-you' ? col.items.length : 0,
      );
      expect(region.queryAllByRole('button', { name: copy.board.actions.archive })).toHaveLength(
        col.key === 'ready' || col.key === 'landed' ? col.items.length : 0,
      );
      // Ready to land opens the lane's Changes page (ADR-0027 §3).
      expect(region.queryAllByRole('button', { name: copy.chat.instruments.changes })).toHaveLength(
        col.key === 'ready' ? col.items.length : 0,
      );
    }
    const count = (label: string) => column(label).getByRole('heading', { level: 3 }).querySelector('span');
    expect(count(copy.board.columns.needsYou)?.getAttribute('data-on')).toBe('true');
    expect(count(copy.board.columns.working)?.getAttribute('data-on')).toBeNull();
    expect(screen.getByRole('button', { name: copy.board.actions.spawn })).toBeTruthy();
  });

  it('Open focuses the session in the workspace of its project', () => {
    render(<Agents />);
    const working = column(copy.board.columns.working);
    fireEvent.click(working.getAllByRole('button', { name: copy.board.actions.open })[0] as HTMLElement);
    const ui = useUiStore.getState();
    expect(ui.screen).toBe('workspace');
    expect(ui.projectId).toBe(acme);
    expect(ui.projectSession[acme]).toBe(fixtures.ids.session.claude);
    expect(ui.overlays).toHaveLength(0);
  });

  it('Review grant opens the session and the grant sheet for the head ask', () => {
    render(<Agents />);
    fireEvent.click(screen.getByRole('button', { name: copy.board.actions.reviewGrant }));
    const ui = useUiStore.getState();
    expect(ui.screen).toBe('workspace');
    expect(ui.projectSession[acme]).toBe(fixtures.ids.session.codex);
    const sheet = ui.overlays.find((o) => o.kind === 'sheet');
    expect(sheet).toMatchObject({ sheet: 'grant', sessionId: fixtures.ids.session.codex });
  });

  it('Review plan opens the workspace without a sheet', () => {
    render(<Agents />);
    fireEvent.click(screen.getByRole('button', { name: copy.board.actions.reviewPlan }));
    const ui = useUiStore.getState();
    expect(ui.screen).toBe('workspace');
    expect(ui.projectId).toBe(fixtures.ids.project.blogV2);
    expect(ui.overlays).toHaveLength(0);
  });

  it('Deny sends grant.deny for grant asks and ask.respond reject for plan asks', () => {
    render(<Agents />);
    const denies = column(copy.board.columns.needsYou).getAllByRole('button', {
      name: copy.board.actions.deny,
    });
    expect(denies).toHaveLength(2);
    fireEvent.click(denies[0] as HTMLElement);
    fireEvent.click(denies[1] as HTMLElement);
    const model = useReadModel.getState().model;
    const grantAsk = model.pendingAsks.byId[fixtures.ids.ask.codexGrant];
    expect(commandMock).toHaveBeenCalledWith('grant.deny', { grantId: grantAsk?.grantId });
    expect(commandMock).toHaveBeenCalledWith('ask.respond', {
      askId: fixtures.ids.ask.blogPlan,
      resolution: { kind: 'plan', outcome: 'rejected', note: null },
    });
  });

  it('Deny on a command approval (a decision ask) answers with its declining option', () => {
    const model = useReadModel.getState().model;
    const grantAsk = model.pendingAsks.byId[fixtures.ids.ask.codexGrant];
    if (!grantAsk) throw new Error('fixture ask');
    // The Codex card's head ask becomes a tool approval with Allow / Deny.
    useReadModel.getState().replaceModel(
      {
        ...model,
        pendingAsks: {
          ...model.pendingAsks,
          byId: {
            ...model.pendingAsks.byId,
            [grantAsk.id]: {
              ...grantAsk,
              kind: 'decision',
              grantId: null,
              payload: { kind: 'decision', prompt: 'Run `pnpm test`?', options: ['Allow', 'Deny'] },
            },
          },
        },
      },
      'connected',
    );
    render(<Agents />);
    const denies = column(copy.board.columns.needsYou).getAllByRole('button', {
      name: copy.board.actions.deny,
    });
    fireEvent.click(denies[0] as HTMLElement);
    expect(commandMock).toHaveBeenCalledWith('ask.respond', {
      askId: grantAsk.id,
      resolution: { kind: 'decision', chosen: 'Deny' },
    });
    expect(denyOptionOf(['Yes', 'No'])).toBe('No');
    expect(denyOptionOf(['Allow once', 'Allow always'])).toBe('Allow always');
  });

  it('Archive sends session.archive and stays on the board', () => {
    render(<Agents />);
    fireEvent.click(
      column(copy.board.columns.landed).getAllByRole('button', {
        name: copy.board.actions.archive,
      })[0] as HTMLElement,
    );
    expect(commandMock).toHaveBeenCalledWith('session.archive', { sessionId: fixtures.ids.session.cursor });
    expect(useUiStore.getState().screen).toBe('agents');
  });

  it('Reopen sends session.reopen, then opens the session in its project once main has it back', async () => {
    render(<Agents />);
    fireEvent.click(
      column(copy.board.columns.landed).getAllByRole('button', {
        name: copy.board.actions.reopen,
      })[0] as HTMLElement,
    );
    expect(commandMock).toHaveBeenCalledWith('session.reopen', { sessionId: fixtures.ids.session.cursor });
    await waitFor(() => expect(useUiStore.getState().screen).toBe('workspace'));
    expect(useUiStore.getState().projectSession[acme]).toBe(fixtures.ids.session.cursor);
  });

  it('a refused reopen stays on the board', async () => {
    commandMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'invalid-transition', message: 'only a finished session can be reopened' },
    } as never);
    render(<Agents />);
    fireEvent.click(
      column(copy.board.columns.landed).getAllByRole('button', {
        name: copy.board.actions.reopen,
      })[0] as HTMLElement,
    );
    await waitFor(() => expect(commandMock).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(useUiStore.getState().screen).toBe('agents');
  });

  it('Changes on a ready card opens the lane on its Changes page; the scope switch narrows to this project', () => {
    // A finished lane on its own branch with unmerged changes: Claude's fix/checkout, marked done.
    const m = fixtures.demoReadModel();
    const s = m.sessions.byId[fixtures.ids.session.claude];
    if (s === undefined) throw new Error('fixture');
    useReadModel.getState().replaceModel(
      {
        ...m,
        sessions: upsertRows(m.sessions, [
          { ...s, state: 'done', endedAt: fixtures.DEMO_NOW, pid: null, exitCode: 0 },
        ]),
      },
      'connected',
    );
    render(<Agents />);
    const ready = column(copy.board.columns.ready);
    fireEvent.click(ready.getAllByRole('button', { name: copy.chat.instruments.changes })[0] as HTMLElement);
    expect(useUiStore.getState().screen).toBe('workspace');
    expect(useUiStore.getState().paneSizes['workspace-mode']).toBe(2);
    useUiStore.setState({ screen: 'agents', boardScope: 'all' });
    cleanup();
    render(<Agents />);
    fireEvent.click(document.querySelector('[data-board-scope]') as HTMLElement);
    expect(useUiStore.getState().boardScope).toBe('project');
  });

  it('+ Spawn agent opens the spawn modal for the current project', () => {
    render(<Agents />);
    fireEvent.click(screen.getByRole('button', { name: copy.board.actions.spawn }));
    expect(useUiStore.getState().overlays.find((o) => o.kind === 'modal')).toMatchObject({
      modal: 'spawn',
      projectId: acme,
    });
  });

  it('Mod+⏎ / Mod+⌫ on a focused needs-you card approve (as requested; once for a Supabase prod write, issue #29) / deny (spec §6 "board card")', () => {
    const off = keys.install(window);
    try {
      render(<Agents />);
      const needs = column(copy.board.columns.needsYou);
      const cards = needs.getAllByRole('group');
      expect(cards).toHaveLength(2);
      const grantCard = cards.find((c) => c.getAttribute('data-session') === fixtures.ids.session.codex);
      const planCard = cards.find((c) => c.getAttribute('data-session') === fixtures.ids.session.blog);
      if (grantCard === undefined || planCard === undefined) throw new Error('fixture cards');
      expect(grantCard.getAttribute('data-keyscope')).toBe('board');
      expect(grantCard.tabIndex).toBe(-1);
      // Working cards are not focusable.
      expect(column(copy.board.columns.working).queryAllByRole('group')).toHaveLength(0);

      const press = (el: HTMLElement, key: string) =>
        fireEvent.keyDown(el, { key, metaKey: true, bubbles: true, cancelable: true });

      grantCard.focus();
      press(grantCard, 'Enter');
      const model = useReadModel.getState().model;
      const grantId = model.pendingAsks.byId[fixtures.ids.ask.codexGrant]?.grantId;
      const grant = grantId == null ? undefined : model.grants.byId[grantId];
      expect(commandMock).toHaveBeenCalledWith('grant.approve', {
        grantId,
        duration: 'once',
        scope: [...(grant?.scope ?? [])],
      });
      press(grantCard, 'Backspace');
      expect(commandMock).toHaveBeenCalledWith('grant.deny', { grantId });

      // Focus inside the card (its Deny button) still resolves to the card's scope.
      const planDeny = within(planCard).getByRole('button', { name: copy.board.actions.deny });
      planDeny.focus();
      press(planDeny, 'Backspace');
      expect(commandMock).toHaveBeenCalledWith('ask.respond', {
        askId: fixtures.ids.ask.blogPlan,
        resolution: { kind: 'plan', outcome: 'rejected', note: null },
      });
      // Plan asks have no grant: Mod+⏎ runs the CTA (Review plan → workspace).
      press(planDeny, 'Enter');
      expect(useUiStore.getState().screen).toBe('workspace');
      expect(useUiStore.getState().projectId).toBe(fixtures.ids.project.blogV2);
    } finally {
      off();
    }
  });

  it('empty fixture shows the verbatim empty copy with 00 counts', () => {
    useReadModel.getState().replaceModel(fixtures.emptyReadModel(), 'connected');
    useUiStore.setState({ projectId: null });
    render(<Agents />);
    expect(screen.getByText(copy.board.empty.needsYou)).toBeTruthy();
    expect(screen.getByText(copy.board.empty.working)).toBeTruthy();
    expect(screen.getByText(copy.board.empty.ready)).toBeTruthy();
    expect(screen.getByText(copy.board.empty.landed)).toBeTruthy();
    expect(document.querySelectorAll('h3 span')).toHaveLength(4);
    for (const n of document.querySelectorAll('h3 span')) expect(n.textContent).toBe('0');
    expect(screen.getByRole('button', { name: copy.board.actions.spawn })).toBeTruthy();
  });
});

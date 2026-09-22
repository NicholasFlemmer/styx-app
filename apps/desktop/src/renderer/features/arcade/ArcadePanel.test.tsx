// @vitest-environment jsdom
import {
  copy,
  fixtures,
  newSnakeGame,
  upsertRows,
  type ProjectId,
  type ReadModel,
  type SessionId,
  type SessionState,
} from '@styx/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rememberInvoker } from '../../overlays/stack';
import { useReadModel } from '../../state/read-model';
import { ARCADE_BEST_KEY, useUiStore } from '../../state/ui-store';
import { ChatPane } from '../chat/ChatPane';
import { ARCADE_INVOKER, ArcadeHeldStrip, ArcadePanel, heldReason, quitArcade } from './ArcadePanel';

const acme = fixtures.ids.project.acmeShop as ProjectId;
const claude = fixtures.ids.session.claude as SessionId;
const codex = fixtures.ids.session.codex as SessionId;

const commands: { name: string; input: unknown }[] = [];

const withState = (state: SessionState, sessionId: SessionId = claude): ReadModel => {
  const model = fixtures.demoReadModel();
  const s = model.sessions.byId[sessionId];
  if (s === undefined) throw new Error('fixture');
  return { ...model, sessions: upsertRows(model.sessions, [{ ...s, state }]) };
};

const setModel = (state: SessionState) =>
  act(() => useReadModel.getState().replaceModel(withState(state), 'connected'));

const frame = () => screen.getByRole('application');

const bridge = () => {
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
};

describe('ArcadePanel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    bridge();
    useReadModel.getState().replaceModel(withState('working'), 'connected');
    useUiStore.setState({
      overlays: [],
      screen: 'workspace',
      platform: 'darwin',
      projectId: acme,
      projectSession: { [acme]: claude },
      paneSizes: {},
      arcade: null,
    });
    useUiStore.getState().openArcade(acme, 7);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Object.assign(window, { styx: undefined });
  });

  it('renders the board with the copy, focused, ready, and the best from the per-machine map', () => {
    useUiStore.setState({ paneSizes: { [ARCADE_BEST_KEY]: 57 } });
    render(<ArcadePanel projectId={acme} sessionId={claude} />);
    expect(document.activeElement).toBe(frame());
    expect(screen.getByText(copy.arcade.title)).toBeTruthy();
    expect(screen.getByText('best 57')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(copy.arcade.ready);
    expect(screen.getByRole('button', { name: copy.arcade.quit })).toBeTruthy();
    expect(document.querySelector('[data-arcade-phase]')?.getAttribute('data-arcade-phase')).toBe('ready');
  });

  it('an arrow starts the game and the engine ticks on its own clock, faster with the score', () => {
    render(<ArcadePanel projectId={acme} sessionId={claude} />);
    fireEvent.keyDown(frame(), { key: 'ArrowUp' });
    expect(useUiStore.getState().arcade?.game.phase).toBe('playing');
    expect(useUiStore.getState().arcade?.game.ticks).toBe(0);
    act(() => vi.advanceTimersByTime(150));
    expect(useUiStore.getState().arcade?.game.ticks).toBe(1);
    expect(useUiStore.getState().arcade?.game.snake[0]).toEqual({ x: 10, y: 7 });
    act(() => vi.advanceTimersByTime(150));
    expect(useUiStore.getState().arcade?.game.ticks).toBe(2);
    // Space pauses: no more moves.
    fireEvent.keyDown(frame(), { key: ' ' });
    expect(useUiStore.getState().arcade?.game.phase).toBe('paused');
    act(() => vi.advanceTimersByTime(1000));
    expect(useUiStore.getState().arcade?.game.ticks).toBe(2);
    expect(screen.getByRole('status').textContent).toBe(copy.arcade.paused);
  });

  it('losing focus mid-game pauses it', () => {
    render(<ArcadePanel projectId={acme} sessionId={claude} />);
    fireEvent.keyDown(frame(), { key: 'Enter' });
    expect(useUiStore.getState().arcade?.game.phase).toBe('playing');
    fireEvent.blur(frame(), { relatedTarget: document.body });
    expect(useUiStore.getState().arcade?.game.phase).toBe('paused');
  });

  it('the tab on screen needing the person holds the game: paused, board gone, strip with the reason, no Resume', () => {
    const { rerender } = render(<ArcadePanel projectId={acme} sessionId={claude} />);
    fireEvent.keyDown(frame(), { key: 'Enter' });
    setModel('needs-you');
    const arcade = useUiStore.getState().arcade;
    expect(arcade?.held).toBe(true);
    expect(arcade?.game.phase).toBe('paused');
    expect(screen.queryByRole('application')).toBeNull();
    rerender(<ArcadeHeldStrip projectId={acme} sessionId={claude} />);
    const strip = screen.getByRole('status');
    expect(strip.textContent).toContain('Claude needs you · Snake is paused at 0');
    expect(strip.getAttribute('data-arcade-held')).toBe('waiting');
    expect(document.activeElement).toBe(strip);
    expect(screen.queryByRole('button', { name: copy.arcade.resume })).toBeNull();
    expect(screen.getByRole('button', { name: copy.arcade.leave })).toBeTruthy();
  });

  it.each<SessionState>(['idle', 'done', 'paused'])(
    'a tab that goes %s does not touch the game (owner: only an ask holds it)',
    (state) => {
      render(<ArcadePanel projectId={acme} sessionId={claude} />);
      fireEvent.keyDown(frame(), { key: 'Enter' });
      setModel(state);
      expect(useUiStore.getState().arcade).toMatchObject({ held: false });
      expect(useUiStore.getState().arcade?.game.phase).toBe('playing');
      expect(screen.getByRole('application')).toBeTruthy();
    },
  );

  it('a game opened on an idle tab plays; switching to a needs-you tab holds it', () => {
    setModel('idle');
    const { rerender } = render(<ArcadePanel projectId={acme} sessionId={claude} />);
    fireEvent.keyDown(frame(), { key: 'Enter' });
    expect(useUiStore.getState().arcade?.game.phase).toBe('playing');
    // The fixture's Codex tab is needs-you.
    rerender(<ArcadePanel projectId={acme} sessionId={codex} />);
    expect(useUiStore.getState().arcade).toMatchObject({ held: true });
    expect(screen.queryByRole('application')).toBeNull();
  });

  it('once the ask is answered Resume brings the board back and counts 3 · 2 · 1 before it moves', () => {
    useUiStore.getState().holdArcade();
    useUiStore.getState().setArcadeGame({ ...newSnakeGame(7), phase: 'paused', ticks: 4 });
    const { rerender } = render(<ArcadeHeldStrip projectId={acme} sessionId={claude} />);
    expect(screen.getByRole('status').getAttribute('data-arcade-held')).toBe('resumable');
    expect(screen.getByRole('status').textContent).toContain('Claude is working again');
    fireEvent.click(screen.getByRole('button', { name: copy.arcade.resume }));
    expect(useUiStore.getState().arcade).toMatchObject({ held: false, countdown: 3 });
    rerender(<ArcadePanel projectId={acme} sessionId={claude} />);
    expect(document.activeElement).toBe(frame());
    const overlay = () => document.querySelector('[data-arcade-overlay]');
    expect(overlay()?.textContent).toBe('3');
    // Keys are ignored while counting.
    fireEvent.keyDown(frame(), { key: 'Enter' });
    expect(useUiStore.getState().arcade?.game.phase).toBe('paused');
    act(() => vi.advanceTimersByTime(400));
    expect(overlay()?.textContent).toBe('2');
    act(() => vi.advanceTimersByTime(400));
    expect(overlay()?.textContent).toBe('1');
    act(() => vi.advanceTimersByTime(400));
    expect(useUiStore.getState().arcade).toMatchObject({ countdown: null });
    expect(useUiStore.getState().arcade?.game.phase).toBe('playing');
    expect(overlay()).toBeNull();
    act(() => vi.advanceTimersByTime(150));
    expect(useUiStore.getState().arcade?.game.ticks).toBe(5);
  });

  it('a ready game resumes without a countdown', () => {
    useUiStore.getState().holdArcade();
    useUiStore.getState().resumeArcade();
    expect(useUiStore.getState().arcade).toMatchObject({ held: false, countdown: null });
  });

  it('Esc quits: the game is gone and focus returns to what opened it; a best is filed', () => {
    const invoker = document.createElement('button');
    document.body.appendChild(invoker);
    rememberInvoker(ARCADE_INVOKER, invoker);
    useUiStore.setState({ paneSizes: { [ARCADE_BEST_KEY]: 2 } });
    useUiStore.getState().setArcadeGame({ ...newSnakeGame(7), score: 5 });
    render(<ArcadePanel projectId={acme} sessionId={claude} />);
    fireEvent.keyDown(frame(), { key: 'Escape' });
    expect(useUiStore.getState().arcade).toBeNull();
    expect(useUiStore.getState().paneSizes[ARCADE_BEST_KEY]).toBe(5);
    expect(commands).toEqual([{ name: 'ui.persist', input: { paneSizes: { [ARCADE_BEST_KEY]: 5 } } }]);
    act(() => vi.runOnlyPendingTimers());
    expect(document.activeElement).toBe(invoker);
    invoker.remove();
  });

  it('a lower score does not touch the best, and the ✕ quits too', () => {
    useUiStore.setState({ paneSizes: { [ARCADE_BEST_KEY]: 9 } });
    useUiStore.getState().setArcadeGame({ ...newSnakeGame(7), score: 5 });
    render(<ArcadePanel projectId={acme} sessionId={claude} />);
    fireEvent.click(screen.getByRole('button', { name: copy.arcade.quit }));
    expect(useUiStore.getState().arcade).toBeNull();
    expect(useUiStore.getState().paneSizes[ARCADE_BEST_KEY]).toBe(9);
    expect(commands).toEqual([]);
  });

  it('game over files the score, shows the word and "new best", and ⏎ starts over', () => {
    useUiStore.setState({ paneSizes: { [ARCADE_BEST_KEY]: 3 } });
    // Head at (10,8) heading right with the food out of the way: nine safe moves, then the wall.
    useUiStore
      .getState()
      .setArcadeGame({ ...newSnakeGame(7), phase: 'playing', score: 4, food: { x: 0, y: 0 } });
    render(<ArcadePanel projectId={acme} sessionId={claude} />);
    expect(screen.getByText(copy.arcade.newBest)).toBeTruthy();
    // One act per move: the next timeout is armed by an effect after each move lands.
    for (let i = 0; i < 9; i += 1) act(() => vi.advanceTimersByTime(134));
    expect(useUiStore.getState().arcade?.game.phase).toBe('playing');
    act(() => vi.advanceTimersByTime(134));
    expect(useUiStore.getState().arcade?.game.phase).toBe('over');
    expect(document.querySelector('[data-arcade-overlay]')?.textContent).toBe(copy.arcade.state.over);
    expect(screen.getByRole('status').textContent).toBe(copy.arcade.over);
    expect(useUiStore.getState().paneSizes[ARCADE_BEST_KEY]).toBe(4);
    expect(commands).toEqual([{ name: 'ui.persist', input: { paneSizes: { [ARCADE_BEST_KEY]: 4 } } }]);
    fireEvent.keyDown(frame(), { key: 'Enter' });
    expect(useUiStore.getState().arcade?.game).toMatchObject({ phase: 'playing', score: 0 });
    expect(screen.getByText('best 4')).toBeTruthy();
  });

  it('leaving the screen mid-game pauses it', () => {
    const { unmount } = render(<ArcadePanel projectId={acme} sessionId={claude} />);
    fireEvent.keyDown(frame(), { key: 'Enter' });
    unmount();
    expect(useUiStore.getState().arcade?.game.phase).toBe('paused');
  });

  it('a project that disappears takes the game with it', () => {
    render(<ArcadePanel projectId={acme} sessionId={claude} />);
    const model = fixtures.demoReadModel();
    act(() =>
      useReadModel
        .getState()
        .replaceModel(
          { ...model, projects: { ...model.projects, byId: {}, ids: [] } as ReadModel['projects'] },
          'connected',
        ),
    );
    expect(useUiStore.getState().arcade).toBeNull();
  });

  it.each<[SessionState | null, string, boolean]>([
    ['needs-you', 'Claude needs you · Snake is paused at 3', false],
    ['working', 'Claude is working again · Snake is paused at 3', true],
    ['done', 'Claude has stopped · Snake is paused at 3', true],
    ['idle', 'Claude has stopped · Snake is paused at 3', true],
    ['paused', 'Claude has stopped · Snake is paused at 3', true],
    [null, 'Snake is paused at 3', true],
  ])('held line for %s', (state, line, canResume) => {
    const arcade = { projectId: acme, game: { ...newSnakeGame(1), score: 3 }, held: true, countdown: null };
    const model = state === null ? fixtures.demoReadModel() : withState(state);
    expect(heldReason(model, arcade, state === null ? null : claude)).toEqual({ line, canResume });
  });

  it('quitArcade with nothing open is a no-op', () => {
    useUiStore.getState().closeArcade();
    quitArcade();
    expect(useUiStore.getState().arcade).toBeNull();
    expect(commands).toEqual([]);
  });
});

describe('ChatPane with Snake', () => {
  beforeEach(() => {
    bridge();
    useReadModel.getState().replaceModel(withState('working'), 'connected');
    useUiStore.setState({
      overlays: [],
      screen: 'workspace',
      platform: 'darwin',
      projectId: acme,
      projectSession: { [acme]: claude },
      composerText: {},
      drafts: {},
      paneSizes: {},
      arcade: null,
    });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('the Snake button under the tab row opens the game, reads pressed while it is open, and closes it again', () => {
    render(<ChatPane projectId={acme} />);
    const button = screen.getByRole('button', { name: copy.arcade.open });
    expect(button.getAttribute('title')).toBe(copy.arcade.openTitle);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('log')).toBeTruthy();
    fireEvent.click(button);
    expect(useUiStore.getState().arcade).toMatchObject({ projectId: acme, held: false });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('data-inv')).toBe('true');
    // The board stands in for the transcript, with the working line under it; the composer stays.
    expect(screen.getByRole('application')).toBeTruthy();
    expect(screen.queryByRole('log')).toBeNull();
    expect(document.querySelector('[data-arcade-panel] [data-working-line]')).not.toBeNull();
    expect(screen.getByPlaceholderText('Message Claude…')).toBeTruthy();
    fireEvent.click(button);
    expect(useUiStore.getState().arcade).toBeNull();
    expect(screen.getByRole('log')).toBeTruthy();
  });

  it('the button is off on a tab that needs you, naming the agent', () => {
    useUiStore.setState({ projectSession: { [acme]: codex } });
    render(<ChatPane projectId={acme} />);
    const button = screen.getByRole('button', { name: copy.arcade.open });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('title')).toBe('Codex needs you first');
  });

  it("another tab keeps the board (the game is the pane's), a needs-you tab holds it", () => {
    useUiStore.getState().openArcade(acme, 7);
    render(<ChatPane projectId={acme} />);
    expect(screen.getByRole('application')).toBeTruthy();
    // Gemini is idle: still the board.
    act(() => useUiStore.getState().setSession(acme, fixtures.ids.session.gemini as SessionId));
    expect(screen.getByRole('application')).toBeTruthy();
    // Codex needs you: the strip and the transcript with the ask.
    act(() => useUiStore.getState().setSession(acme, codex));
    expect(screen.queryByRole('application')).toBeNull();
    expect(screen.getByRole('log')).toBeTruthy();
    expect(document.querySelector('[data-arcade-held]')?.getAttribute('data-arcade-held')).toBe('waiting');
    // Back on Claude (working): Resume is on offer.
    act(() => useUiStore.getState().setSession(acme, claude));
    expect(document.querySelector('[data-arcade-held]')?.getAttribute('data-arcade-held')).toBe('resumable');
  });

  it('never in the pop-out', () => {
    useUiStore.getState().openArcade(acme, 7);
    render(<ChatPane projectId={acme} compact sessionId={claude} />);
    expect(screen.queryByRole('application')).toBeNull();
    expect(screen.queryByRole('button', { name: copy.arcade.open })).toBeNull();
  });
});

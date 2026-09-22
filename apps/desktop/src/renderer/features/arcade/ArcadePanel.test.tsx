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

const commands: { name: string; input: unknown }[] = [];

const withState = (state: SessionState): ReadModel => {
  const model = fixtures.demoReadModel();
  const s = model.sessions.byId[claude];
  if (s === undefined) throw new Error('fixture');
  return { ...model, sessions: upsertRows(model.sessions, [{ ...s, state }]) };
};

const setModel = (state: SessionState) =>
  act(() => useReadModel.getState().replaceModel(withState(state), 'connected'));

const frame = () => screen.getByRole('application');

describe('ArcadePanel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
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
    useUiStore.getState().openArcade(claude, 7);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Object.assign(window, { styx: undefined });
  });

  it('renders the board with the copy, focused, ready, and the best from the per-machine map', () => {
    useUiStore.setState({ paneSizes: { [ARCADE_BEST_KEY]: 57 } });
    render(<ArcadePanel sessionId={claude} />);
    expect(document.activeElement).toBe(frame());
    expect(screen.getByText(copy.arcade.title)).toBeTruthy();
    expect(screen.getByText('best 57')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(copy.arcade.ready);
    expect(screen.getByRole('button', { name: copy.arcade.quit })).toBeTruthy();
    expect(document.querySelector('[data-arcade-phase]')?.getAttribute('data-arcade-phase')).toBe('ready');
  });

  it('an arrow starts the game and the engine ticks on its own clock, faster with the score', () => {
    render(<ArcadePanel sessionId={claude} />);
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
    render(<ArcadePanel sessionId={claude} />);
    fireEvent.keyDown(frame(), { key: 'Enter' });
    expect(useUiStore.getState().arcade?.game.phase).toBe('playing');
    fireEvent.blur(frame(), { relatedTarget: document.body });
    expect(useUiStore.getState().arcade?.game.phase).toBe('paused');
  });

  it('the session leaving `working` holds the game: paused, board gone, strip with the reason and no Resume', () => {
    const { rerender } = render(<ArcadePanel sessionId={claude} />);
    fireEvent.keyDown(frame(), { key: 'Enter' });
    setModel('needs-you');
    const arcade = useUiStore.getState().arcade;
    expect(arcade?.held).toBe(true);
    expect(arcade?.game.phase).toBe('paused');
    expect(screen.queryByRole('application')).toBeNull();
    rerender(<ArcadeHeldStrip sessionId={claude} />);
    const strip = screen.getByRole('status');
    expect(strip.textContent).toContain('Claude needs you · Snake is paused at 0');
    expect(strip.getAttribute('data-arcade-held')).toBe('waiting');
    expect(document.activeElement).toBe(strip);
    expect(screen.queryByRole('button', { name: copy.arcade.resume })).toBeNull();
    expect(screen.getByRole('button', { name: copy.arcade.leave })).toBeTruthy();
  });

  it('once the agent is working again Resume brings the board back and counts 3 · 2 · 1 before it moves', () => {
    useUiStore.getState().holdArcade();
    useUiStore.getState().setArcadeGame({ ...newSnakeGame(7), phase: 'paused', ticks: 4 });
    const { rerender } = render(<ArcadeHeldStrip sessionId={claude} />);
    expect(screen.getByRole('status').getAttribute('data-arcade-held')).toBe('resumable');
    expect(screen.getByRole('status').textContent).toContain('Claude is working again');
    fireEvent.click(screen.getByRole('button', { name: copy.arcade.resume }));
    expect(useUiStore.getState().arcade).toMatchObject({ held: false, countdown: 3 });
    rerender(<ArcadePanel sessionId={claude} />);
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
    render(<ArcadePanel sessionId={claude} />);
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
    render(<ArcadePanel sessionId={claude} />);
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
    render(<ArcadePanel sessionId={claude} />);
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
    const { unmount } = render(<ArcadePanel sessionId={claude} />);
    fireEvent.keyDown(frame(), { key: 'Enter' });
    unmount();
    expect(useUiStore.getState().arcade?.game.phase).toBe('paused');
  });

  it('a session that disappears takes the game with it', () => {
    render(<ArcadePanel sessionId={claude} />);
    const model = fixtures.demoReadModel();
    act(() =>
      useReadModel
        .getState()
        .replaceModel(
          { ...model, sessions: { ...model.sessions, byId: {}, ids: [] } as ReadModel['sessions'] },
          'connected',
        ),
    );
    expect(useUiStore.getState().arcade).toBeNull();
  });

  it.each<[SessionState, string, boolean]>([
    ['needs-you', 'Claude needs you · Snake is paused at 3', false],
    ['working', 'Claude is working again · Snake is paused at 3', true],
    ['done', 'Claude is done · Snake is paused at 3', false],
    ['idle', 'Claude has stopped · Snake is paused at 3', false],
    ['paused', 'Claude has stopped · Snake is paused at 3', false],
  ])('held line for %s', (state, line, canResume) => {
    const arcade = { sessionId: claude, game: { ...newSnakeGame(1), score: 3 }, held: true, countdown: null };
    expect(heldReason(withState(state), arcade)).toEqual({ line, canResume });
  });

  it('quitArcade with nothing open is a no-op', () => {
    useUiStore.getState().closeArcade();
    quitArcade();
    expect(useUiStore.getState().arcade).toBeNull();
    expect(commands).toEqual([]);
  });
});

describe('ChatPane with Snake open', () => {
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
    useUiStore.getState().openArcade(claude, 7);
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('the board stands in for the transcript, with the working line under it; the composer stays', () => {
    render(<ChatPane projectId={acme} />);
    expect(screen.getByRole('application')).toBeTruthy();
    expect(screen.queryByRole('log')).toBeNull();
    expect(document.querySelector('[data-arcade-panel] [data-working-line]')).not.toBeNull();
    expect(screen.getByPlaceholderText('Message Claude…')).toBeTruthy();
  });

  it('another tab shows its own transcript, not the board', () => {
    useUiStore.setState({ projectSession: { [acme]: fixtures.ids.session.codex as SessionId } });
    render(<ChatPane projectId={acme} />);
    expect(screen.queryByRole('application')).toBeNull();
    expect(screen.getByRole('log')).toBeTruthy();
  });

  it('held, the strip sits over the transcript and the ask is visible again', () => {
    act(() => useUiStore.getState().holdArcade());
    render(<ChatPane projectId={acme} />);
    expect(screen.queryByRole('application')).toBeNull();
    expect(screen.getByRole('log')).toBeTruthy();
    expect(document.querySelector('[data-arcade-held]')).not.toBeNull();
  });

  it('never in the pop-out', () => {
    render(<ChatPane projectId={acme} compact sessionId={claude} />);
    expect(screen.queryByRole('application')).toBeNull();
  });
});

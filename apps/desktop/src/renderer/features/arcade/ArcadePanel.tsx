import {
  copy,
  fill,
  pauseSnake,
  snakeTickMs,
  startSnake,
  tickSnake,
  turnSnake,
  type ReadModel,
  type SessionId,
  type SnakeDirection,
} from '@styx/core';
import { Button, SnakeBoard, type SnakeBoardLabels } from '@styx/ui';
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { restoreInvoker } from '../../overlays/stack';
import { command } from '../../state/commands';
import { useModel, useUi } from '../../state/hooks';
import { ARCADE_BEST_KEY, useUiStore, type ArcadeState } from '../../state/ui-store';
import s from './ArcadePanel.module.css';

/** The overlay-stack key under which the palette remembers what opened the game (focus goes back there on quit). */
export const ARCADE_INVOKER = 'arcade';

/** One count of the 3 · 2 · 1. */
const COUNTDOWN_MS = 400;

/** Why the game is held, from the session's state; `working` means the agent came back and Resume is on offer. */
export const heldReason = (
  model: ReadModel,
  arcade: ArcadeState,
): { line: string; canResume: boolean } | null => {
  const session = model.sessions.byId[arcade.sessionId];
  if (session === undefined) return null;
  const vars = { agent: copy.agents[session.agent], n: String(arcade.game.score) };
  switch (session.state) {
    case 'needs-you':
      return { line: fill(copy.arcade.held.needsYou, vars), canResume: false };
    case 'working':
      return { line: fill(copy.arcade.held.working, vars), canResume: true };
    case 'done':
      return { line: fill(copy.arcade.held.done, vars), canResume: false };
    case 'idle':
    case 'paused':
      return { line: fill(copy.arcade.held.stopped, vars), canResume: false };
  }
};

/** Writes a new high score to the per-machine map (the same one that holds the pane sizes). */
const commitBest = (score: number): void => {
  const ui = useUiStore.getState();
  const best = ui.paneSizes[ARCADE_BEST_KEY] ?? 0;
  if (score <= best) return;
  ui.setPaneSize(ARCADE_BEST_KEY, score);
  void command('ui.persist', { paneSizes: { [ARCADE_BEST_KEY]: score } });
};

/** Esc / ✕ / Quit: the score is kept if it is a best, the game goes, focus returns to what opened it. */
export const quitArcade = (): void => {
  const ui = useUiStore.getState();
  if (ui.arcade !== null) commitBest(ui.arcade.game.score);
  ui.closeArcade();
  restoreInvoker(ARCADE_INVOKER);
};

const hintFor = (arcade: ArcadeState): string => {
  if (arcade.countdown !== null) return copy.arcade.playing;
  switch (arcade.game.phase) {
    case 'ready':
      return copy.arcade.ready;
    case 'playing':
      return copy.arcade.playing;
    case 'paused':
      return copy.arcade.paused;
    case 'over':
      return copy.arcade.over;
  }
};

const stateFor = (arcade: ArcadeState): string => {
  switch (arcade.game.phase) {
    case 'ready':
      return copy.arcade.state.ready;
    case 'paused':
      return copy.arcade.state.paused;
    case 'over':
      return copy.arcade.state.over;
    case 'playing':
      return '';
  }
};

/**
 * Keeps the store's game honest against the session (discrepancy row 110): the moment the session leaves
 * `working` the game is held (paused, board gone, transcript back — the ask is what the pane shows), and a
 * session that no longer exists takes the game with it. Mounted by the strip and the board alike.
 */
const useArcadeGuard = (sessionId: SessionId): void => {
  const state = useModel(
    useCallback((m: ReadModel) => m.sessions.byId[sessionId]?.state ?? null, [sessionId]),
  );
  const held = useUi((u) => u.arcade?.held ?? false);
  useEffect(() => {
    const ui = useUiStore.getState();
    if (ui.arcade === null || ui.arcade.sessionId !== sessionId) return;
    if (state === null) {
      quitArcade();
      return;
    }
    if (state !== 'working' && !held) {
      commitBest(ui.arcade.game.score);
      ui.holdArcade();
    }
  }, [state, held, sessionId]);
};

/**
 * The strip over the transcript while the game is held: why, the score it stopped at, Resume once the agent is
 * working again, Quit always. Takes focus when it appears so a keyboard player is not left on a board that is
 * no longer there.
 */
export function ArcadeHeldStrip({ sessionId }: { sessionId: SessionId }) {
  useArcadeGuard(sessionId);
  const arcade = useUi((u) => u.arcade);
  const resume = useUi((u) => u.resumeArcade);
  const reason = useModel(
    useCallback((m: ReadModel) => (arcade === null ? null : heldReason(m, arcade)), [arcade]),
  );
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.focus();
  }, []);
  if (arcade === null || reason === null) return null;
  return (
    <div
      ref={root}
      className={s['held']}
      role="status"
      tabIndex={-1}
      data-arcade-held={reason.canResume ? 'resumable' : 'waiting'}
    >
      <span className={['t-meta', s['heldLine']].join(' ')}>{reason.line}</span>
      {reason.canResume && (
        <Button size="compact" onClick={resume} data-arcade-resume="true">
          {copy.arcade.resume}
        </Button>
      )}
      <Button variant="ghost" size="compact" onClick={quitArcade} data-arcade-quit="true">
        {copy.arcade.leave}
      </Button>
    </div>
  );
}

/**
 * The board in the transcript's place: the engine ticks here (a timeout per move, faster with the score), the
 * countdown runs here, and the high score is written when a game ends. The tab's working line sits under it as
 * `footer` so the person is still looking at the agent they are waiting for.
 */
export function ArcadePanel({ sessionId, footer }: { sessionId: SessionId; footer?: ReactNode }) {
  useArcadeGuard(sessionId);
  const arcade = useUi((u) => u.arcade);
  const best = useUi((u) => u.paneSizes[ARCADE_BEST_KEY] ?? 0);
  const setGame = useUi((u) => u.setArcadeGame);
  const setCountdown = useUi((u) => u.setArcadeCountdown);

  const phase = arcade?.game.phase ?? null;
  const ticks = arcade?.game.ticks ?? 0;
  const score = arcade?.game.score ?? 0;
  const held = arcade?.held ?? true;
  const countdown = arcade?.countdown ?? null;

  // One move per timeout: the score sets the pace, and every move re-arms the next. Nothing runs while paused,
  // held or counting down.
  useEffect(() => {
    if (phase !== 'playing' || held || countdown !== null) return;
    const id = setTimeout(() => {
      const cur = useUiStore.getState().arcade;
      if (cur !== null && cur.sessionId === sessionId) setGame(tickSnake(cur.game));
    }, snakeTickMs(score));
    return () => clearTimeout(id);
  }, [phase, held, countdown, ticks, score, sessionId, setGame]);

  useEffect(() => {
    if (countdown === null) return;
    const id = setTimeout(() => {
      const cur = useUiStore.getState().arcade;
      if (cur === null || cur.countdown === null) return;
      if (cur.countdown > 1) {
        setCountdown(cur.countdown - 1);
        return;
      }
      setCountdown(null);
      setGame(startSnake(cur.game));
    }, COUNTDOWN_MS);
    return () => clearTimeout(id);
  }, [countdown, setCountdown, setGame]);

  // A finished game files its score.
  useEffect(() => {
    if (phase === 'over') commitBest(score);
  }, [phase, score]);

  // The board leaving the screen mid-game (another tab, another screen) pauses it: the moves stop with the
  // timeouts anyway, and a game that came back moving on its own would be over before the person had looked.
  useEffect(
    () => () => {
      const cur = useUiStore.getState().arcade;
      if (cur !== null && cur.sessionId === sessionId && cur.game.phase === 'playing')
        useUiStore.getState().setArcadeGame(pauseSnake(cur.game));
    },
    [sessionId],
  );

  const onDirection = useCallback(
    (dir: SnakeDirection) => {
      const cur = useUiStore.getState().arcade;
      if (cur === null || cur.countdown !== null) return;
      setGame(turnSnake(cur.game, dir));
    },
    [setGame],
  );
  const onStart = useCallback(() => {
    const cur = useUiStore.getState().arcade;
    if (cur === null || cur.countdown !== null) return;
    setGame(startSnake(cur.game));
  }, [setGame]);
  const onPause = useCallback(() => {
    const cur = useUiStore.getState().arcade;
    if (cur === null) return;
    setGame(pauseSnake(cur.game));
  }, [setGame]);

  if (arcade === null || arcade.sessionId !== sessionId || arcade.held) return null;
  const game = arcade.game;
  const bestBeaten = best > 0 && game.score > best;
  const labels: SnakeBoardLabels = {
    title: copy.arcade.title,
    score: copy.arcade.score,
    best: fill(copy.arcade.best, { n: String(best) }),
    newBest: copy.arcade.newBest,
    state: stateFor(arcade),
    hint: hintFor(arcade),
    board: fill(copy.arcade.board, { n: String(game.score) }),
    quit: copy.arcade.quit,
  };
  return (
    <div className={s['panel']} data-arcade-panel={sessionId}>
      <SnakeBoard
        cols={game.cols}
        rows={game.rows}
        snake={game.snake}
        food={game.food}
        score={game.score}
        phase={game.phase}
        countdown={arcade.countdown}
        bestBeaten={bestBeaten}
        labels={labels}
        onDirection={onDirection}
        onStart={onStart}
        onPause={onPause}
        onQuit={quitArcade}
        autoFocus
      />
      {footer !== undefined && <div className={s['footer']}>{footer}</div>}
    </div>
  );
}

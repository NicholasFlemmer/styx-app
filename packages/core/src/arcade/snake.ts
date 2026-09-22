/**
 * Snake, the "play while you wait" game (owner addition, discrepancy row 110). Pure and deterministic: the board is
 * a grid of cells, one tick moves the snake one cell, and food lands on a seeded pseudo-random free cell so a
 * game replays the same way from the same seed. The renderer owns the clock; nothing here reads time.
 *
 * Kept discrete on purpose: the app freezes the game the instant its session needs the person, and a stepped
 * game resumes exactly where it stopped. Reduced motion is the same game (there is nothing to animate).
 */

export interface SnakeCell {
  x: number;
  y: number;
}

export type SnakeDirection = 'up' | 'down' | 'left' | 'right';

/** `ready` waits for the first key, `over` waits for ⏎ to start again. */
export type SnakePhase = 'ready' | 'playing' | 'paused' | 'over';

export interface SnakeGame {
  cols: number;
  rows: number;
  /** Head first. Never mutated by the engine (a mutable type only so the UI store's drafts accept it). */
  snake: SnakeCell[];
  /** The direction of the last move (a turn straight back into the body is refused against this). */
  dir: SnakeDirection;
  /** The direction the next tick moves in. */
  next: SnakeDirection;
  /** `null` once the snake fills the board. */
  food: SnakeCell | null;
  score: number;
  phase: SnakePhase;
  /** Pseudo-random state (LCG); advanced every time food is placed. */
  seed: number;
  ticks: number;
}

/** 20 × 16 cells fits the 360px chat pane at 16px a cell and its 280px minimum at 12px. */
export const SNAKE_COLS = 20;
export const SNAKE_ROWS = 16;
const START_LENGTH = 3;

/** Tick length by score: 150ms at the start, 4ms faster per point, never under 70ms. */
export const snakeTickMs = (score: number): number => Math.max(70, 150 - score * 4);

const OPPOSITE: Record<SnakeDirection, SnakeDirection> = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
};

const STEP: Record<SnakeDirection, SnakeCell> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

/** Numerical Recipes LCG, 32-bit. */
const nextSeed = (seed: number): number => (Math.imul(seed, 1664525) + 1013904223) >>> 0;

const sameCell = (a: SnakeCell, b: SnakeCell): boolean => a.x === b.x && a.y === b.y;

const occupied = (snake: readonly SnakeCell[], cell: SnakeCell): boolean =>
  snake.some((c) => sameCell(c, cell));

/** Food on a free cell chosen by the seed, scanning the board row by row; `null` when no cell is free. */
const placeFood = (
  cols: number,
  rows: number,
  snake: readonly SnakeCell[],
  seed: number,
): { food: SnakeCell | null; seed: number } => {
  const free: SnakeCell[] = [];
  for (let y = 0; y < rows; y += 1)
    for (let x = 0; x < cols; x += 1) if (!occupied(snake, { x, y })) free.push({ x, y });
  const advanced = nextSeed(seed);
  // No free cell: the index is NaN, nothing is picked, and the seed is left where it was.
  const food = free[advanced % free.length] ?? null;
  return { food, seed: food === null ? seed : advanced };
};

/** A fresh board: three cells long, mid-board, heading right, waiting for the first key. */
export const newSnakeGame = (seed: number, cols = SNAKE_COLS, rows = SNAKE_ROWS): SnakeGame => {
  const y = Math.floor(rows / 2);
  const headX = Math.floor(cols / 2);
  const snake: SnakeCell[] = [];
  for (let i = 0; i < START_LENGTH; i += 1) snake.push({ x: headX - i, y });
  const placed = placeFood(cols, rows, snake, seed >>> 0);
  return {
    cols,
    rows,
    snake,
    dir: 'right',
    next: 'right',
    food: placed.food,
    score: 0,
    phase: 'ready',
    seed: placed.seed,
    ticks: 0,
  };
};

/**
 * ⏎: a ready or paused game plays; a finished game starts over on the same board (the seed carries on, so the
 * new game is not the old one replayed).
 */
export const startSnake = (g: SnakeGame): SnakeGame => {
  switch (g.phase) {
    case 'ready':
    case 'paused':
      return { ...g, phase: 'playing' };
    case 'over':
      return { ...newSnakeGame(g.seed, g.cols, g.rows), phase: 'playing' };
    case 'playing':
      return g;
  }
};

/** Space, or the board losing focus: only a playing game pauses. */
export const pauseSnake = (g: SnakeGame): SnakeGame =>
  g.phase === 'playing' ? { ...g, phase: 'paused' } : g;

/**
 * An arrow (or h j k l): queues the direction for the next tick; a turn straight back into the body is ignored.
 * A ready or paused game starts playing on its first arrow; a finished game does not (⏎ restarts it, so a key
 * held down at the end cannot start a new game by accident).
 */
export const turnSnake = (g: SnakeGame, dir: SnakeDirection): SnakeGame => {
  if (g.phase === 'over') return g;
  const started: SnakeGame = g.phase === 'playing' ? g : { ...g, phase: 'playing' };
  // Only a reversal is refused; re-pressing the current heading cancels a queued turn, which is a real move.
  if (dir === OPPOSITE[g.dir]) return started;
  return started.next === dir ? started : { ...started, next: dir };
};

/** One move. Walls and the body end the game; food grows the snake by one and scores a point. */
export const tickSnake = (g: SnakeGame): SnakeGame => {
  if (g.phase !== 'playing') return g;
  const head = g.snake[0];
  if (head === undefined) return g;
  const step = STEP[g.next];
  const to: SnakeCell = { x: head.x + step.x, y: head.y + step.y };
  const ticks = g.ticks + 1;
  const eats = g.food !== null && sameCell(to, g.food);
  // The tail cell frees up this tick unless the snake grows, so moving into it is not a collision.
  const body = eats ? g.snake : g.snake.slice(0, -1);
  const hitsWall = to.x < 0 || to.y < 0 || to.x >= g.cols || to.y >= g.rows;
  if (hitsWall || occupied(body, to)) return { ...g, dir: g.next, phase: 'over', ticks };
  const snake = [to, ...body];
  if (!eats) return { ...g, snake, dir: g.next, ticks };
  const placed = placeFood(g.cols, g.rows, snake, g.seed);
  return {
    ...g,
    snake,
    dir: g.next,
    food: placed.food,
    seed: placed.seed,
    score: g.score + 1,
    // A full board is a win; there is nothing left to do but start over.
    phase: placed.food === null ? 'over' : 'playing',
    ticks,
  };
};

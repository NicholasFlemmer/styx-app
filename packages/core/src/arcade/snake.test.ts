import { describe, expect, it } from 'vitest';
import {
  newSnakeGame,
  pauseSnake,
  snakeTickMs,
  startSnake,
  tickSnake,
  turnSnake,
  type SnakeDirection,
  type SnakeGame,
  type SnakePhase,
} from './snake';

const playing = (seed = 1, cols?: number, rows?: number): SnakeGame =>
  startSnake(newSnakeGame(seed, cols, rows));

const run = (g: SnakeGame, n: number): SnakeGame => {
  let cur = g;
  for (let i = 0; i < n; i += 1) cur = tickSnake(cur);
  return cur;
};

describe('newSnakeGame', () => {
  it('starts three long in the middle, heading right, ready, with food off the snake', () => {
    const g = newSnakeGame(7);
    expect(g.cols).toBe(20);
    expect(g.rows).toBe(16);
    expect(g.snake).toEqual([
      { x: 10, y: 8 },
      { x: 9, y: 8 },
      { x: 8, y: 8 },
    ]);
    expect(g.dir).toBe('right');
    expect(g.next).toBe('right');
    expect(g.phase).toBe('ready');
    expect(g.score).toBe(0);
    expect(g.ticks).toBe(0);
    expect(g.food).not.toBeNull();
    expect(g.snake.some((c) => c.x === g.food?.x && c.y === g.food?.y)).toBe(false);
  });

  it('is deterministic per seed and differs across seeds', () => {
    expect(newSnakeGame(42)).toEqual(newSnakeGame(42));
    expect(newSnakeGame(1).food).not.toEqual(newSnakeGame(2).food);
  });

  it('has no food when the snake already fills the board', () => {
    // 2 × 1: the two cells of the board are the snake's head and neck.
    const g = newSnakeGame(1, 2, 1);
    expect(g.snake.slice(0, 2)).toEqual([
      { x: 1, y: 0 },
      { x: 0, y: 0 },
    ]);
    expect(g.food).toBeNull();
  });
});

describe('startSnake / pauseSnake', () => {
  const table: { from: SnakePhase; start: SnakePhase; pause: SnakePhase }[] = [
    { from: 'ready', start: 'playing', pause: 'ready' },
    { from: 'playing', start: 'playing', pause: 'paused' },
    { from: 'paused', start: 'playing', pause: 'paused' },
    { from: 'over', start: 'playing', pause: 'over' },
  ];
  it.each(table)('$from → start $start, pause $pause', ({ from, start, pause }) => {
    const g: SnakeGame = { ...newSnakeGame(3), phase: from, score: 5 };
    expect(startSnake(g).phase).toBe(start);
    expect(pauseSnake(g).phase).toBe(pause);
  });

  it('starting over from a finished game resets the board but keeps rolling the seed', () => {
    const over: SnakeGame = { ...run(playing(3), 6), phase: 'over', score: 9 };
    const again = startSnake(over);
    expect(again.phase).toBe('playing');
    expect(again.score).toBe(0);
    expect(again.snake).toHaveLength(3);
    expect(again.seed).not.toBe(newSnakeGame(3).seed);
  });

  it('returns the same object when nothing changes', () => {
    const g = playing();
    expect(startSnake(g)).toBe(g);
    const ready = newSnakeGame(1);
    expect(pauseSnake(ready)).toBe(ready);
  });
});

describe('turnSnake', () => {
  const g = playing();
  const table: { dir: SnakeDirection; next: SnakeDirection }[] = [
    { dir: 'up', next: 'up' },
    { dir: 'down', next: 'down' },
    { dir: 'right', next: 'right' },
    // Straight back into the body is refused.
    { dir: 'left', next: 'right' },
  ];
  it.each(table)('heading right, $dir → next $next', ({ dir, next }) => {
    expect(turnSnake(g, dir).next).toBe(next);
  });

  it('starts a ready or paused game and leaves a finished one alone', () => {
    expect(turnSnake(newSnakeGame(1), 'up').phase).toBe('playing');
    expect(turnSnake({ ...g, phase: 'paused' }, 'up').phase).toBe('playing');
    const over: SnakeGame = { ...g, phase: 'over' };
    expect(turnSnake(over, 'up')).toBe(over);
  });

  it('a reversal still starts a ready game, and a repeated heading is the same object', () => {
    const ready = newSnakeGame(1);
    expect(turnSnake(ready, 'left')).toEqual({ ...ready, phase: 'playing' });
    expect(turnSnake(g, 'right')).toBe(g);
  });

  it('re-pressing the heading cancels a queued turn, and a queued turn is judged against the last move', () => {
    const queuedUp = turnSnake(g, 'up');
    expect(turnSnake(queuedUp, 'right').next).toBe('right');
    // dir is still right, so down is not a reversal even though up is queued.
    expect(turnSnake(queuedUp, 'down').next).toBe('down');
  });
});

describe('tickSnake', () => {
  it('moves one cell in the queued direction and records the move as the heading', () => {
    const g = turnSnake(playing(), 'up');
    const t = tickSnake(g);
    expect(t.snake[0]).toEqual({ x: 10, y: 7 });
    expect(t.snake).toHaveLength(3);
    expect(t.dir).toBe('up');
    expect(t.ticks).toBe(1);
    expect(t.phase).toBe('playing');
  });

  it.each<SnakePhase>(['ready', 'paused', 'over'])('does nothing while %s', (phase) => {
    const g: SnakeGame = { ...newSnakeGame(1), phase };
    expect(tickSnake(g)).toBe(g);
  });

  it('ends at the right wall', () => {
    // Head at x=10 of 20: nine more moves are fine, the tenth hits the wall.
    const g = playing(99);
    const nine = run(g, 9);
    expect(nine.phase).toBe('playing');
    expect(nine.snake[0]?.x).toBe(19);
    const ten = tickSnake(nine);
    expect(ten.phase).toBe('over');
    expect(ten.ticks).toBe(10);
    expect(ten.snake).toEqual(nine.snake);
  });

  it.each<[SnakeDirection, number]>([
    // Head at (10, 8) on 20 × 16: eight cells up to y=0, seven down to y=15, and — one row up, then back
    // left (a reversal is refused) — ten cells to x=0.
    ['up', 8],
    ['down', 7],
    ['left', 10],
  ])('ends at the %s wall after %i safe moves', (dir, safe) => {
    let g = turnSnake(playing(5), dir === 'left' ? 'up' : dir);
    if (dir === 'left') g = turnSnake(tickSnake(g), 'left');
    const before = run(g, safe);
    expect(before.phase).toBe('playing');
    expect(tickSnake(before).phase).toBe('over');
  });

  it('eats food: grows by one, scores, places new food elsewhere, keeps playing', () => {
    // Put the food straight ahead.
    const g: SnakeGame = { ...playing(1), food: { x: 11, y: 8 } };
    const t = tickSnake(g);
    expect(t.score).toBe(1);
    expect(t.snake).toHaveLength(4);
    expect(t.snake[0]).toEqual({ x: 11, y: 8 });
    expect(t.snake[3]).toEqual({ x: 8, y: 8 });
    expect(t.food).not.toBeNull();
    expect(t.food).not.toEqual({ x: 11, y: 8 });
    expect(t.snake.some((c) => c.x === t.food?.x && c.y === t.food?.y)).toBe(false);
    expect(t.seed).not.toBe(g.seed);
    expect(t.phase).toBe('playing');
  });

  it('a snake that fills the board wins: no food, game over', () => {
    // 4 × 1 board, snake of three heading right with the last free cell as food.
    const g: SnakeGame = {
      ...newSnakeGame(1, 4, 1),
      snake: [
        { x: 2, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 0 },
      ],
      food: { x: 3, y: 0 },
      phase: 'playing',
    };
    const t = tickSnake(g);
    expect(t.score).toBe(1);
    expect(t.food).toBeNull();
    expect(t.phase).toBe('over');
  });

  it('running into the body ends the game, but the tail cell that frees up this tick is safe', () => {
    // A 2 × 2 loop: the head chases its own tail without ever growing.
    const loop: SnakeGame = {
      ...newSnakeGame(1, 5, 5),
      snake: [
        { x: 1, y: 1 },
        { x: 0, y: 1 },
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      dir: 'right',
      next: 'down',
      food: { x: 4, y: 4 },
      phase: 'playing',
    };
    const a = tickSnake(loop); // head (1,2)
    expect(a.phase).toBe('playing');
    const b = tickSnake(turnSnake(a, 'left')); // head (0,2)
    const c = tickSnake(turnSnake(b, 'up')); // head (0,1) — that cell is the tail of b, freed this tick
    expect(c.phase).toBe('playing');
    expect(c.snake[0]).toEqual({ x: 0, y: 1 });
    // Now a real collision: a long snake turning into its own middle.
    const bite: SnakeGame = {
      ...loop,
      snake: [
        { x: 2, y: 2 },
        { x: 2, y: 1 },
        { x: 1, y: 1 },
        { x: 1, y: 2 },
        { x: 1, y: 3 },
        { x: 2, y: 3 },
      ],
      dir: 'down',
      next: 'left',
    };
    expect(tickSnake(bite).phase).toBe('over');
  });

  it('a headless game (never produced by the engine) is left untouched', () => {
    const g: SnakeGame = { ...playing(), snake: [] };
    expect(tickSnake(g)).toBe(g);
  });

  it('a long game from one seed is reproducible', () => {
    const a = run(turnSnake(playing(12345), 'up'), 5);
    const b = run(turnSnake(playing(12345), 'up'), 5);
    expect(a).toEqual(b);
  });
});

describe('snakeTickMs', () => {
  it('speeds up with the score and floors at 70ms', () => {
    expect(snakeTickMs(0)).toBe(150);
    expect(snakeTickMs(10)).toBe(110);
    expect(snakeTickMs(20)).toBe(70);
    expect(snakeTickMs(50)).toBe(70);
  });
});

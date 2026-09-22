import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type FocusEvent,
  type HTMLAttributes,
  type KeyboardEvent,
} from 'react';
import { Icon, Numeral } from '../../primitives';
import s from './SnakeBoard.module.css';

export interface SnakeBoardCell {
  x: number;
  y: number;
}

export type SnakeBoardDirection = 'up' | 'down' | 'left' | 'right';
export type SnakeBoardPhase = 'ready' | 'playing' | 'paused' | 'over';

export interface SnakeBoardLabels {
  /** "Snake" (app: `copy.arcade.title`). */
  title: string;
  /** Accessible name of the score numeral. */
  score: string;
  /** "best 57", already filled. */
  best: string;
  /** "new best": replaces `best` while the running score beats it. */
  newBest: string;
  /** The word over the board while it is not playing: "Ready" / "Paused" / "Game over" (empty for none). */
  state: string;
  /** The line under the board for the current phase, already chosen by the app. */
  hint: string;
  /** Accessible name of the board, already filled with the score. */
  board: string;
  /** Accessible name of the ✕. */
  quit: string;
}

export interface SnakeBoardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onKeyDown' | 'onBlur'> {
  cols: number;
  rows: number;
  /** Head first. */
  snake: readonly SnakeBoardCell[];
  food: SnakeBoardCell | null;
  score: number;
  phase: SnakeBoardPhase;
  /** 3 · 2 · 1 over the board before play resumes after the app held the game. */
  countdown?: number | null;
  bestBeaten?: boolean;
  labels: SnakeBoardLabels;
  /** Cell size in px; measured from the container width (8–16px) when not given. */
  cell?: number;
  onDirection: (dir: SnakeBoardDirection) => void;
  /** ⏎ */
  onStart: () => void;
  /** Space, and the board losing focus mid-game. */
  onPause: () => void;
  /** Esc and the ✕. */
  onQuit: () => void;
  autoFocus?: boolean;
}

export interface SnakeBoardHandle {
  focus(): void;
}

/** Arrow keys and the vim / wasd letters (the diff review's j k already mean down / up in the app). */
export const snakeDirectionOfKey = (key: string): SnakeBoardDirection | null => {
  switch (key) {
    case 'ArrowUp':
    case 'k':
    case 'w':
      return 'up';
    case 'ArrowDown':
    case 'j':
    case 's':
      return 'down';
    case 'ArrowLeft':
    case 'h':
    case 'a':
      return 'left';
    case 'ArrowRight':
    case 'l':
    case 'd':
      return 'right';
    default:
      return null;
  }
};

const MIN_CELL = 8;
const MAX_CELL = 16;
const DEFAULT_CELL = 12;

/** Whole pixels per cell from the width on offer, so every square lands on the pixel grid. */
export const snakeCellFor = (width: number, cols: number): number =>
  width <= 0 ? DEFAULT_CELL : Math.max(MIN_CELL, Math.min(MAX_CELL, Math.floor(width / cols)));

/**
 * Snake board (owner addition, discrepancy row 110): a header with the t-label title, the score in the counters'
 * numerals and the best, the grid as an SVG of 1px-inset squares (body in text colour, food the accent square —
 * the same shape as the needs-you dot), and one hint line. The frame is the focus target (`role=application`:
 * the arrows are the game's) and pauses the game when focus leaves it. Stepped movement, so reduced motion is the
 * same board.
 */
export const SnakeBoard = forwardRef<SnakeBoardHandle, SnakeBoardProps>(function SnakeBoard(
  {
    cols,
    rows,
    snake,
    food,
    score,
    phase,
    countdown = null,
    bestBeaten = false,
    labels,
    cell: cellProp,
    onDirection,
    onStart,
    onPause,
    onQuit,
    autoFocus = false,
    className,
    ...rest
  },
  ref,
) {
  const root = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(DEFAULT_CELL);
  useImperativeHandle(ref, () => ({ focus: () => frame.current?.focus() }), []);

  useEffect(() => {
    if (cellProp !== undefined) return;
    const el = root.current;
    if (el === null) return;
    const measure = () => setMeasured(snakeCellFor(el.clientWidth, cols));
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [cellProp, cols]);

  useEffect(() => {
    if (autoFocus) frame.current?.focus();
  }, [autoFocus]);

  const cell = cellProp ?? measured;
  const width = cols * cell;
  const height = rows * cell;

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const dir = snakeDirectionOfKey(e.key);
      if (dir !== null) {
        e.preventDefault();
        onDirection(dir);
        return;
      }
      switch (e.key) {
        case 'Enter':
          e.preventDefault();
          onStart();
          return;
        case ' ':
          e.preventDefault();
          if (phase === 'playing') onPause();
          else onStart();
          return;
        case 'Escape':
          e.preventDefault();
          onQuit();
          return;
        default:
      }
    },
    [onDirection, onStart, onPause, onQuit, phase],
  );

  const onBlur = useCallback(
    (e: FocusEvent<HTMLDivElement>) => {
      if (e.currentTarget.contains(e.relatedTarget)) return;
      if (phase === 'playing') onPause();
    },
    [onPause, phase],
  );

  const covered = phase !== 'playing' || countdown !== null;

  return (
    <div
      ref={root}
      className={[s['root'], className].filter(Boolean).join(' ')}
      data-arcade="snake"
      data-arcade-phase={phase}
      data-arcade-score={score}
      {...rest}
    >
      <div className={s['head']}>
        <span className={['t-label', s['title']].join(' ')}>{labels.title}</span>
        <Numeral value={score} size="M" aria-label={labels.score} className={s['score']} />
        <span
          className={['t-meta', s['best'], bestBeaten ? s['newBest'] : undefined].filter(Boolean).join(' ')}
          data-arcade-best={bestBeaten ? 'beaten' : 'standing'}
        >
          {bestBeaten ? labels.newBest : labels.best}
        </span>
        <button type="button" className={s['quit']} aria-label={labels.quit} onClick={onQuit}>
          <Icon name="close" size={10} />
        </button>
      </div>
      <div
        ref={frame}
        role="application"
        tabIndex={0}
        aria-label={labels.board}
        className={s['frame']}
        style={{ width, height }}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        data-arcade-frame="true"
      >
        <svg
          className={s['svg']}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          aria-hidden="true"
          focusable="false"
        >
          {snake.map((c, i) =>
            i === 0 ? (
              // The head is the one full square: it shows which way the snake faces before the first move.
              <rect
                key={`${c.x},${c.y}`}
                className={s['body']}
                x={c.x * cell}
                y={c.y * cell}
                width={cell}
                height={cell}
                data-arcade-head="true"
              />
            ) : (
              <rect
                key={`${c.x},${c.y}`}
                className={s['body']}
                x={c.x * cell + 1}
                y={c.y * cell + 1}
                width={cell - 2}
                height={cell - 2}
              />
            ),
          )}
          {food !== null && (
            <rect
              className={s['food']}
              x={food.x * cell + 1}
              y={food.y * cell + 1}
              width={cell - 2}
              height={cell - 2}
              data-arcade-food="true"
            />
          )}
        </svg>
        {covered && (
          <div className={s['overlay']} data-arcade-overlay={countdown === null ? phase : 'countdown'}>
            {countdown !== null ? (
              <Numeral value={countdown} size="L" pad={1} className={s['count']} aria-hidden="true" />
            ) : labels.state === '' ? null : (
              <span className={['t-label', s['state']].join(' ')}>{labels.state}</span>
            )}
          </div>
        )}
      </div>
      <div className={['t-meta', s['hint']].join(' ')} role="status" aria-live="polite">
        {labels.hint}
      </div>
    </div>
  );
});

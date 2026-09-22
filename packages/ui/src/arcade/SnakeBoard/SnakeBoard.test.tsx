import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SnakeBoard, snakeCellFor, snakeDirectionOfKey, type SnakeBoardProps } from './SnakeBoard';

afterEach(cleanup);

const labels: SnakeBoardProps['labels'] = {
  title: 'Snake',
  score: 'Score',
  best: 'best 57',
  newBest: 'new best',
  state: 'Ready',
  hint: '⏎ or an arrow to start',
  board: 'Snake board · score 0',
  quit: 'Quit Snake',
};

const setup = (over: Partial<SnakeBoardProps> = {}) => {
  const onDirection = vi.fn();
  const onStart = vi.fn();
  const onPause = vi.fn();
  const onQuit = vi.fn();
  const utils = render(
    <SnakeBoard
      cols={20}
      rows={16}
      snake={[
        { x: 10, y: 8 },
        { x: 9, y: 8 },
        { x: 8, y: 8 },
      ]}
      food={{ x: 2, y: 3 }}
      score={0}
      phase="ready"
      labels={labels}
      cell={12}
      onDirection={onDirection}
      onStart={onStart}
      onPause={onPause}
      onQuit={onQuit}
      {...over}
    />,
  );
  return { ...utils, onDirection, onStart, onPause, onQuit, frame: screen.getByRole('application') };
};

describe('SnakeBoard', () => {
  it('draws the head as a full square, the body and the food inset by 1px, at the cell size', () => {
    const { container } = setup();
    const rects = container.querySelectorAll('rect');
    expect(rects).toHaveLength(4);
    const head = container.querySelector('[data-arcade-head]');
    expect(head?.getAttribute('x')).toBe('120');
    expect(head?.getAttribute('width')).toBe('12');
    expect(rects[1]?.getAttribute('x')).toBe('109');
    expect(rects[1]?.getAttribute('width')).toBe('10');
    const food = container.querySelector('[data-arcade-food]');
    expect(food?.getAttribute('x')).toBe('25');
    expect(food?.getAttribute('y')).toBe('37');
    const frame = screen.getByRole('application');
    expect(frame.style.width).toBe('240px');
    expect(frame.style.height).toBe('192px');
    expect(container.querySelector('[data-arcade-frame] svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('exposes the score as a numeral with a name, the best, and the hint as a polite status', () => {
    setup({ score: 7 });
    expect(screen.getByLabelText('Score').textContent).toBe('07');
    expect(screen.getByText('best 57').getAttribute('data-arcade-best')).toBe('standing');
    expect(screen.getByRole('status').textContent).toBe('⏎ or an arrow to start');
    expect(screen.getByRole('application').getAttribute('aria-label')).toBe('Snake board · score 0');
    expect(screen.getByRole('button', { name: 'Quit Snake' })).toBeTruthy();
    const root = screen.getByRole('application').parentElement;
    expect(root?.getAttribute('data-arcade')).toBe('snake');
    expect(root?.getAttribute('data-arcade-phase')).toBe('ready');
    expect(root?.getAttribute('data-arcade-score')).toBe('7');
  });

  it('shows "new best" in place of the best once beaten', () => {
    setup({ bestBeaten: true });
    expect(screen.getByText('new best').getAttribute('data-arcade-best')).toBe('beaten');
    expect(screen.queryByText('best 57')).toBeNull();
  });

  it.each([
    ['ArrowUp', 'up'],
    ['ArrowDown', 'down'],
    ['ArrowLeft', 'left'],
    ['ArrowRight', 'right'],
    ['h', 'left'],
    ['j', 'down'],
    ['k', 'up'],
    ['l', 'right'],
    ['w', 'up'],
    ['a', 'left'],
    ['s', 'down'],
    ['d', 'right'],
  ])('%s turns %s and is consumed', (key, dir) => {
    const { frame, onDirection } = setup();
    const ev = fireEvent.keyDown(frame, { key });
    expect(onDirection).toHaveBeenCalledWith(dir);
    // fireEvent returns false when preventDefault was called.
    expect(ev).toBe(false);
  });

  it('⏎ starts, Space pauses a playing game and starts any other, Esc quits', () => {
    const ready = setup();
    fireEvent.keyDown(ready.frame, { key: 'Enter' });
    expect(ready.onStart).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(ready.frame, { key: ' ' });
    expect(ready.onStart).toHaveBeenCalledTimes(2);
    expect(ready.onPause).not.toHaveBeenCalled();
    fireEvent.keyDown(ready.frame, { key: 'Escape' });
    expect(ready.onQuit).toHaveBeenCalledTimes(1);
    cleanup();
    const playing = setup({ phase: 'playing' });
    fireEvent.keyDown(playing.frame, { key: ' ' });
    expect(playing.onPause).toHaveBeenCalledTimes(1);
    expect(playing.onStart).not.toHaveBeenCalled();
  });

  it('leaves chords and other keys alone so the app shortcuts still work from the board', () => {
    const { frame, onDirection, onStart } = setup();
    expect(fireEvent.keyDown(frame, { key: 'k', metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(frame, { key: 'Enter', ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(frame, { key: 'x' })).toBe(true);
    expect(onDirection).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
  });

  it('pauses when focus leaves the board mid-game, not when idle', () => {
    const playing = setup({ phase: 'playing' });
    playing.frame.focus();
    fireEvent.blur(playing.frame, { relatedTarget: document.body });
    expect(playing.onPause).toHaveBeenCalledTimes(1);
    cleanup();
    const ready = setup();
    ready.frame.focus();
    fireEvent.blur(ready.frame, { relatedTarget: document.body });
    expect(ready.onPause).not.toHaveBeenCalled();
  });

  it('focuses the frame on autoFocus and through the handle', () => {
    setup({ autoFocus: true });
    expect(document.activeElement).toBe(screen.getByRole('application'));
  });

  it('the ✕ quits', () => {
    const { onQuit } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Quit Snake' }));
    expect(onQuit).toHaveBeenCalledTimes(1);
  });

  it('covers the board with the state word while not playing, and with the countdown numeral when counting', () => {
    const { container, rerender } = setup({ phase: 'paused', labels: { ...labels, state: 'Paused' } });
    expect(container.querySelector('[data-arcade-overlay]')?.getAttribute('data-arcade-overlay')).toBe(
      'paused',
    );
    expect(container.querySelector('[data-arcade-overlay]')?.textContent).toBe('Paused');
    rerender(
      <SnakeBoard
        cols={20}
        rows={16}
        snake={[{ x: 1, y: 1 }]}
        food={null}
        score={0}
        phase="paused"
        countdown={3}
        labels={labels}
        cell={12}
        onDirection={() => {}}
        onStart={() => {}}
        onPause={() => {}}
        onQuit={() => {}}
      />,
    );
    const overlay = container.querySelector('[data-arcade-overlay]');
    expect(overlay?.getAttribute('data-arcade-overlay')).toBe('countdown');
    expect(overlay?.textContent).toBe('3');
    expect(container.querySelector('[data-arcade-food]')).toBeNull();
    rerender(
      <SnakeBoard
        cols={20}
        rows={16}
        snake={[{ x: 1, y: 1 }]}
        food={null}
        score={0}
        phase="playing"
        labels={labels}
        cell={12}
        onDirection={() => {}}
        onStart={() => {}}
        onPause={() => {}}
        onQuit={() => {}}
      />,
    );
    expect(container.querySelector('[data-arcade-overlay]')).toBeNull();
  });

  it('an empty state word leaves the overlay bare', () => {
    const { container } = setup({ phase: 'over', labels: { ...labels, state: '' } });
    expect(container.querySelector('[data-arcade-overlay]')?.textContent).toBe('');
  });

  it('sizes cells from the width on offer, whole pixels between 8 and 16', () => {
    expect(snakeCellFor(0, 20)).toBe(12);
    expect(snakeCellFor(332, 20)).toBe(16);
    expect(snakeCellFor(252, 20)).toBe(12);
    expect(snakeCellFor(100, 20)).toBe(8);
    expect(snakeCellFor(1000, 20)).toBe(16);
    expect(snakeDirectionOfKey('Enter')).toBeNull();
  });

  it('measures its container when no cell size is given', () => {
    const { container } = render(
      <SnakeBoard
        cols={20}
        rows={16}
        snake={[{ x: 1, y: 1 }]}
        food={null}
        score={0}
        phase="ready"
        labels={labels}
        onDirection={() => {}}
        onStart={() => {}}
        onPause={() => {}}
        onQuit={() => {}}
      />,
    );
    // jsdom reports a 0 width, so the default 12px applies.
    expect(screen.getByRole('application').style.width).toBe('240px');
    expect(container.querySelector('[data-arcade-frame] svg')?.getAttribute('width')).toBe('240');
  });
});

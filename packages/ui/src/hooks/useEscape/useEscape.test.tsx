import { cleanup, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEscape } from './useEscape';

afterEach(cleanup);

function Listener({
  active = true,
  enabled = true,
  onEscape,
}: {
  active?: boolean;
  enabled?: boolean;
  onEscape: () => void;
}) {
  useEscape(active, onEscape, enabled);
  return null;
}

describe('useEscape', () => {
  it('calls onEscape on Escape when active', async () => {
    const user = userEvent.setup();
    const fn = vi.fn();
    render(<Listener onEscape={fn} />);
    await user.keyboard('{Escape}');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('ignores Escape when inactive or disabled', async () => {
    const user = userEvent.setup();
    const a = vi.fn();
    const b = vi.fn();
    render(
      <>
        <Listener active={false} onEscape={a} />
        <Listener enabled={false} onEscape={b} />
      </>,
    );
    await user.keyboard('{Escape}');
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it('only the topmost (latest) listener handles Esc; after it unmounts the next one does', async () => {
    const user = userEvent.setup();
    const below = vi.fn();
    const top = vi.fn();
    const { rerender } = render(
      <>
        <Listener onEscape={below} />
        <Listener onEscape={top} />
      </>,
    );
    await user.keyboard('{Escape}');
    expect(top).toHaveBeenCalledTimes(1);
    expect(below).not.toHaveBeenCalled();
    rerender(<Listener onEscape={below} />);
    await user.keyboard('{Escape}');
    expect(below).toHaveBeenCalledTimes(1);
  });
});

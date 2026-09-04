import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTimeout } from './useTimeout';

function Timer({ delay, cb }: { delay: number | null; cb: () => void }) {
  useTimeout(cb, delay);
  return null;
}

describe('useTimeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires once after the delay', () => {
    const cb = vi.fn();
    render(<Timer delay={100} cb={cb} />);
    vi.advanceTimersByTime(99);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('null pauses and a new delay restarts', () => {
    const cb = vi.fn();
    const { rerender } = render(<Timer delay={100} cb={cb} />);
    vi.advanceTimersByTime(50);
    rerender(<Timer delay={null} cb={cb} />);
    vi.advanceTimersByTime(200);
    expect(cb).not.toHaveBeenCalled();
    rerender(<Timer delay={100} cb={cb} />);
    vi.advanceTimersByTime(100);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('clears on unmount', () => {
    const cb = vi.fn();
    const { unmount } = render(<Timer delay={100} cb={cb} />);
    unmount();
    vi.advanceTimersByTime(200);
    expect(cb).not.toHaveBeenCalled();
  });
});

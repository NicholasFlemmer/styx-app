import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toast } from './Toast';

afterEach(cleanup);

const actions = (review = vi.fn(), later = vi.fn()) => [
  { label: 'Review', onClick: review, primary: true },
  { label: 'Later', onClick: later },
];

describe('Toast', () => {
  it('renders as a status with heading, meta, title, detail and actions', async () => {
    const user = userEvent.setup();
    const review = vi.fn();
    render(
      <Toast
        heading="Needs you"
        meta="Styx · now"
        title="Codex wants Supabase prod · write"
        detail='acme-shop · "migration 0042"'
        actions={actions(review)}
        ttl={null}
      />,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Needs you');
    expect(status).toHaveTextContent('Styx · now');
    expect(status).toHaveTextContent('Codex wants Supabase prod · write');
    await user.click(screen.getByText('Review'));
    expect(review).toHaveBeenCalledTimes(1);
  });

  describe('auto-dismiss', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('dismisses after ttl (default 8000)', () => {
      const onDismiss = vi.fn();
      render(<Toast heading="Needs you" meta="Styx · now" title="t" onDismiss={onDismiss} />);
      act(() => vi.advanceTimersByTime(7999));
      expect(onDismiss).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(1));
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('pauses while hovered and while focused', () => {
      const onDismiss = vi.fn();
      render(<Toast heading="Needs you" meta="Styx · now" title="t" ttl={1000} onDismiss={onDismiss} actions={actions()} />);
      const status = screen.getByRole('status');
      fireEvent.mouseEnter(status);
      act(() => vi.advanceTimersByTime(5000));
      expect(onDismiss).not.toHaveBeenCalled();
      fireEvent.mouseLeave(status);
      act(() => screen.getByText('Review').focus());
      act(() => vi.advanceTimersByTime(5000));
      expect(onDismiss).not.toHaveBeenCalled();
      act(() => screen.getByText('Review').blur());
      act(() => vi.advanceTimersByTime(1000));
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('never dismisses when ttl is null', () => {
      const onDismiss = vi.fn();
      render(<Toast heading="Needs you" meta="Styx · now" title="t" ttl={null} onDismiss={onDismiss} />);
      act(() => vi.advanceTimersByTime(60_000));
      expect(onDismiss).not.toHaveBeenCalled();
    });
  });
});

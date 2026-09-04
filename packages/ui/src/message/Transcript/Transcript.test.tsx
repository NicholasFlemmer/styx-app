import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Transcript } from './Transcript';

function fakeScrollMetrics(el: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
}

describe('Transcript', () => {
  it('is a polite live log', () => {
    render(<Transcript>hi</Transcript>);
    const log = screen.getByRole('log');
    expect(log).toHaveAttribute('aria-live', 'polite');
  });

  it('pins to the bottom on new children when within 24px of the bottom', () => {
    const { rerender } = render(<Transcript data-testid="t">a</Transcript>);
    const el = screen.getByTestId('t');
    fakeScrollMetrics(el, 1000, 300);
    rerender(<Transcript data-testid="t">ab</Transcript>);
    expect(el.scrollTop).toBe(1000);
    // Reader scrolls up: 1000 - 500 - 300 = 200px from bottom → unpinned.
    el.scrollTop = 500;
    el.dispatchEvent(new Event('scroll'));
    fakeScrollMetrics(el, 1200, 300);
    rerender(<Transcript data-testid="t">abc</Transcript>);
    expect(el.scrollTop).toBe(500);
    // Back near the bottom (within 24px) → pinned again.
    el.scrollTop = 1200 - 300 - 10;
    el.dispatchEvent(new Event('scroll'));
    fakeScrollMetrics(el, 1400, 300);
    rerender(<Transcript data-testid="t">abcd</Transcript>);
    expect(el.scrollTop).toBe(1400);
  });
});

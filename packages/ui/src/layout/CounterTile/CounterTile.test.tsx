import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CounterTile, CounterStrip } from './CounterTile';

describe('CounterTile', () => {
  it('renders zero-padded value and label', () => {
    render(<CounterTile value={2} label="Needs you" />);
    expect(screen.getByText('02')).toBeInTheDocument();
    expect(screen.getByText('Needs you')).toBeInTheDocument();
  });
  it('is a polite live region only when live', () => {
    const { container, rerender } = render(<CounterTile value={2} label="Needs you" live />);
    expect(container.firstElementChild).toHaveAttribute('aria-live', 'polite');
    expect(container.firstElementChild).toHaveAttribute('aria-atomic', 'true');
    rerender(<CounterTile value={2} label="Needs you" />);
    expect(container.firstElementChild).not.toHaveAttribute('aria-live');
  });
  it('strip lays out the requested column count', () => {
    const { container } = render(
      <CounterStrip columns={3}>
        <CounterTile value={1} label="a" />
      </CounterStrip>,
    );
    expect(container.firstElementChild).toHaveStyle({ gridTemplateColumns: 'repeat(3, 1fr)' });
  });
});

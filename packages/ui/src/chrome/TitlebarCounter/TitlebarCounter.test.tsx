import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TitlebarCounter } from './TitlebarCounter';

describe('TitlebarCounter', () => {
  it('renders a zero-padded count with label', () => {
    const { container } = render(<TitlebarCounter count={2} label="needs you" />);
    expect(container.firstElementChild).toHaveTextContent('02 needs you');
    // Numeral and label are separate flex items (prototype: the 6px gap, not a space, separates them).
    expect(screen.getByText('02')).toBeInTheDocument();
    expect(screen.getByText('needs you')).toBeInTheDocument();
  });
  it('is a polite live region only when live', () => {
    const { container, rerender } = render(<TitlebarCounter count={2} label="needs you" live />);
    expect(container.firstElementChild).toHaveAttribute('aria-live', 'polite');
    rerender(<TitlebarCounter count={1} label="locked" tone="hollowStrong" />);
    expect(container.firstElementChild).not.toHaveAttribute('aria-live');
    expect(container.querySelector('[data-tone="hollowStrong"]')).toBeInTheDocument();
  });
});

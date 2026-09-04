import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusDot } from './StatusDot';

describe('StatusDot', () => {
  it('is decorative without a label', () => {
    const { container } = render(<StatusDot tone="text" />);
    const dot = container.firstElementChild;
    expect(dot).toHaveAttribute('aria-hidden', 'true');
    expect(dot).toHaveAttribute('data-tone', 'text');
  });
  it('exposes a label as an img role', () => {
    render(<StatusDot tone="accent" label="needs you" />);
    expect(screen.getByRole('img', { name: 'needs you' })).not.toHaveAttribute('aria-hidden');
  });
  it('sets data-on when armed', () => {
    render(<StatusDot tone="hollow" on label="needs you" />);
    expect(screen.getByRole('img')).toHaveAttribute('data-on', 'true');
    expect(screen.getByRole('img')).not.toHaveAttribute('data-inv');
  });
});

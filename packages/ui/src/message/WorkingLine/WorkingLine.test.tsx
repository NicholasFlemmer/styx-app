import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkingLine } from './WorkingLine';

afterEach(cleanup);

describe('WorkingLine', () => {
  it('is a non-announcing status row: decorative accent dot, label, elapsed', () => {
    const { container } = render(<WorkingLine label="Running Bash…" elapsedLabel="37s" />);
    const row = screen.getByRole('status');
    expect(row.getAttribute('aria-live')).toBe('off');
    expect(row.getAttribute('data-working-line')).toBe('true');
    const dot = container.querySelector('[data-tone="accent"]');
    expect(dot?.getAttribute('aria-hidden')).toBe('true');
    expect(dot?.className).toMatch(/s7/);
    expect(dot?.className).toMatch(/dot/);
    expect(row.textContent).toBe('Running Bash…37s');
  });

  it('omits the elapsed span without a label and adds the compact class', () => {
    const { container } = render(<WorkingLine label="Working…" compact />);
    expect(screen.getByRole('status').textContent).toBe('Working…');
    expect(container.querySelector('[class*="elapsed"]')).toBeNull();
    expect(screen.getByRole('status').className).toMatch(/compact/);
  });

  it('forwards extra attributes', () => {
    render(<WorkingLine label="Working…" data-testid="wl" />);
    expect(screen.getByTestId('wl')).toBe(screen.getByRole('status'));
  });
});

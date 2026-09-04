import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Textarea } from './Textarea';

describe('Textarea', () => {
  it('accepts typing', async () => {
    render(<Textarea aria-label="Brief" />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Brief' }), 'hello');
    expect(screen.getByRole('textbox')).toHaveValue('hello');
  });
  it('applies minHeight inline (default 64)', () => {
    const { rerender } = render(<Textarea aria-label="a" />);
    expect(screen.getByRole('textbox')).toHaveStyle({ minHeight: '64px' });
    rerender(<Textarea aria-label="a" minHeight={96} />);
    expect(screen.getByRole('textbox')).toHaveStyle({ minHeight: '96px' });
  });
  it('sets data attributes only when true', () => {
    render(<Textarea aria-label="a" inv />);
    expect(screen.getByRole('textbox')).toHaveAttribute('data-inv', 'true');
    expect(screen.getByRole('textbox')).not.toHaveAttribute('data-on');
  });
});

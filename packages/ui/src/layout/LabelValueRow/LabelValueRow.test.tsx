import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LabelValueRow } from './LabelValueRow';

describe('LabelValueRow', () => {
  it('renders label and control', () => {
    render(<LabelValueRow label="Theme" control={<select aria-label="Theme" />} />);
    expect(screen.getByText('Theme')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Theme' })).toBeInTheDocument();
  });
  it('shows Reset only when overridden and onReset given', async () => {
    const onReset = vi.fn();
    const { rerender } = render(<LabelValueRow label="a" overridden onReset={onReset} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(onReset).toHaveBeenCalledTimes(1);
    rerender(<LabelValueRow label="a" overridden />);
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull();
    rerender(<LabelValueRow label="a" onReset={onReset} />);
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull();
  });
  it('marks overridden rows', () => {
    const { container } = render(<LabelValueRow label="a" overridden />);
    expect(container.firstElementChild).toHaveAttribute('data-overridden', 'true');
    expect(container.firstElementChild).not.toHaveAttribute('data-inv');
  });
});

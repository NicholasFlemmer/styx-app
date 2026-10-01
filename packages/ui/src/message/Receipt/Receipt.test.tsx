import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Receipt } from './Receipt';

describe('Receipt', () => {
  it('is a collapsed button that opens the turn on click or Enter', async () => {
    const onClick = vi.fn();
    render(<Receipt title="Add dark mode" meta="Kept 09:12" state="kept" onClick={onClick} />);
    const btn = screen.getByRole('button', { name: /Add dark mode/ });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(btn).toHaveAttribute('data-state', 'kept');
    await userEvent.click(btn);
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(2);
  });
});

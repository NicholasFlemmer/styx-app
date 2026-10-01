import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LaneRow } from './LaneRow';

describe('LaneRow', () => {
  it('is a button named by its task and status', () => {
    render(<LaneRow agent="claude" task="Dark mode on Settings" status="Working, 2m" />);
    const btn = screen.getByRole('button', { name: /^Dark mode on Settings\s*Working, 2m$/ });
    expect(btn).toHaveAttribute('type', 'button');
    expect(btn).not.toHaveAttribute('aria-current');
  });
  it('marks the open lane current, and accent-fills the status when the move is yours', () => {
    render(<LaneRow agent="codex" task="Fix it" status="Your turn" tone="yours" inv />);
    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('aria-current', 'page');
    expect(btn).toHaveAttribute('data-inv', 'true');
    expect(screen.getByText('Your turn')).toHaveAttribute('data-on', 'true');
  });
  it('opens on click, Enter and Space', async () => {
    const onClick = vi.fn();
    render(<LaneRow agent="gemini" task="Explain" status="Ready to land" onClick={onClick} />);
    await userEvent.click(screen.getByRole('button'));
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(3);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OpenTurn } from './OpenTurn';

describe('OpenTurn', () => {
  it('is headed by its open receipt, which folds the turn on click', async () => {
    const onFold = vi.fn();
    render(
      <OpenTurn title="Add dark mode" meta="Kept 09:12" state="kept" onFold={onFold}>
        <p>Done: a switch in Settings.</p>
      </OpenTurn>,
    );
    const head = screen.getByRole('button', { name: /Add dark mode/ });
    expect(head).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Done: a switch in Settings.')).toBeTruthy();
    await userEvent.click(head);
    expect(onFold).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TurnResult, type TurnResultLabels } from './TurnResult';

const labels: TurnResultLabels = {
  showChanges: 'Show changes',
  undo: 'Undo this turn',
  undoAsk: 'Put the files back?',
  undoConfirm: 'Undo it',
  undoCancel: 'Keep it',
  kept: 'Kept when you carry on',
  undone: 'Undone',
  busy: 'Wait',
  before: 'Before',
  after: 'After',
};
const props = (over: Partial<Parameters<typeof TurnResult>[0]> = {}) => ({
  done: 'Done in 4 min',
  change: '3 files, +42 −3',
  undone: false,
  busy: false,
  labels,
  onShowChanges: vi.fn(),
  onUndo: vi.fn(),
  ...over,
});

describe('TurnResult', () => {
  it('shows the turn and opens its changes', async () => {
    const p = props();
    render(<TurnResult {...p}>What it did</TurnResult>);
    expect(screen.getByText('Done in 4 min')).toBeTruthy();
    expect(screen.getByText('What it did')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Show changes' }));
    expect(p.onShowChanges).toHaveBeenCalledOnce();
  });

  it('asks before undoing: the confirm takes focus, Escape puts the actions back, only the confirm undoes', async () => {
    const p = props();
    render(<TurnResult {...p} />);
    await userEvent.click(screen.getByRole('button', { name: 'Undo this turn' }));
    expect(screen.getByText('Put the files back?')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Undo it' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByText('Put the files back?')).toBeNull();
    expect(p.onUndo).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Undo this turn' }));
    await userEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(p.onUndo).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Undo this turn' }));
    await userEvent.click(screen.getByRole('button', { name: 'Undo it' }));
    expect(p.onUndo).toHaveBeenCalledOnce();
  });

  it('cannot undo mid-turn, and once undone shows only that', () => {
    const { rerender } = render(<TurnResult {...props({ busy: true })} />);
    expect(screen.getByRole('button', { name: 'Undo this turn' })).toBeDisabled();
    rerender(<TurnResult {...props({ undone: true })} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Undone')).toBeTruthy();
  });

  it('shows the before and after screenshots it has, named', () => {
    render(<TurnResult {...props({ before: 'data:,a', after: 'data:,b' })} />);
    expect(screen.getByRole('img', { name: 'Before' })).toHaveAttribute('src', 'data:,a');
    expect(screen.getByRole('img', { name: 'After' })).toHaveAttribute('src', 'data:,b');
  });
});

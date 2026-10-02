import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LaneHeader } from './LaneHeader';

describe('LaneHeader', () => {
  it('names the agent and branch, heads the pane with the task, and says what the lane holds', () => {
    render(
      <LaneHeader
        agent="codex"
        agentName="Codex"
        branch="agent/codex-1"
        task="Fix the flaky orders test"
        summary="No changes yet"
        action={<button type="button">Land on main</button>}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Fix the flaky orders test' })).toBeTruthy();
    expect(screen.getByText('agent/codex-1')).toBeTruthy();
    expect(screen.getByText('No changes yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Land on main' })).toBeTruthy();
  });

  afterEach(() => vi.restoreAllMocks());

  it('a task longer than two lines opens to read in full on click, and folds again', async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(120);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(40);
    const task = 'Rework checkout so a guest can pay without an account, then cover it with tests';
    render(<LaneHeader agent="claude" agentName="Claude" branch="agent/claude-1" task={task} summary="" />);
    const toggle = screen.getByRole('button', { name: task });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('heading', { name: task })).toHaveAttribute('data-expanded', 'true');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('a short task is plain text, not a button', () => {
    render(<LaneHeader agent="claude" agentName="Claude" branch="b" task="Short" summary="" />);
    expect(screen.queryByRole('button', { name: 'Short' })).toBeNull();
  });
});

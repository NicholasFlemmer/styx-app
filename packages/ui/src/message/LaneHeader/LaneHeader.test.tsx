import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});

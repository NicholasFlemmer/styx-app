import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StepList } from './StepList';

const base = {
  steps: [
    { key: '1', label: 'Read a.ts', status: 'ok' as const },
    { key: '2', label: 'Ran pnpm test', status: 'running' as const },
  ],
  summary: '2 steps',
  labels: { showTools: 'Show the tool calls', hideTools: 'Hide the tool calls' },
  tools: <span>raw rows</span>,
};

describe('StepList', () => {
  it('live: lists every step, and swaps to the raw tool rows on request', async () => {
    const onToggleTools = vi.fn();
    const { rerender } = render(
      <StepList
        {...base}
        live
        open={false}
        onToggle={vi.fn()}
        showTools={false}
        onToggleTools={onToggleTools}
      />,
    );
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Read a.ts',
      'Ran pnpm test',
    ]);
    expect(screen.queryByRole('button', { name: '2 steps' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show the tool calls' }));
    expect(onToggleTools).toHaveBeenCalledOnce();
    rerender(
      <StepList {...base} live open={false} onToggle={vi.fn()} showTools onToggleTools={onToggleTools} />,
    );
    expect(screen.getByText('raw rows')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hide the tool calls' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('finished: folds to its summary, which opens and closes the list', async () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <StepList
        {...base}
        live={false}
        open={false}
        onToggle={onToggle}
        showTools={false}
        onToggleTools={vi.fn()}
      />,
    );
    const summary = screen.getByRole('button', { name: '2 steps' });
    expect(summary).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('list')).toBeNull();
    await userEvent.click(summary);
    expect(onToggle).toHaveBeenCalledOnce();
    rerender(
      <StepList {...base} live={false} open onToggle={onToggle} showTools={false} onToggleTools={vi.fn()} />,
    );
    expect(screen.getByRole('list')).toBeTruthy();
  });
});

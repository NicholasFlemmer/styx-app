import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tab, TabRow } from './Tab';

describe('Tab', () => {
  it('renders a tab inside a tablist with aria-selected from inv', () => {
    render(
      <TabRow aria-label="Sessions">
        <Tab label="Claude" inv />
        <Tab label="Codex" />
      </TabRow>,
    );
    expect(screen.getByRole('tablist', { name: 'Sessions' })).toBeInTheDocument();
    const [a, b] = screen.getAllByRole('tab');
    expect(a).toHaveAttribute('aria-selected', 'true');
    expect(a).toHaveAttribute('data-inv', 'true');
    expect(b).toHaveAttribute('aria-selected', 'false');
    expect(b).not.toHaveAttribute('data-inv');
  });
  it('fires onClick via mouse and keyboard', async () => {
    const onClick = vi.fn();
    render(<Tab label="Codex" onClick={onClick} />);
    await userEvent.click(screen.getByRole('tab'));
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(2);
  });
  it('renders badge, dot, meta and overflow chevron', () => {
    const { container } = render(<Tab label="Codex" dot="accent" badge meta={<span>M</span>} overflow />);
    expect(screen.getByRole('img', { name: 'needs you' })).toHaveTextContent('!');
    expect(container.querySelector('[data-tone="accent"]')).toBeInTheDocument();
    expect(screen.getByText('M')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeInTheDocument();
  });
  it('is a button of type=button', () => {
    render(<Tab label="x" />);
    expect(screen.getByRole('tab')).toHaveAttribute('type', 'button');
  });
});

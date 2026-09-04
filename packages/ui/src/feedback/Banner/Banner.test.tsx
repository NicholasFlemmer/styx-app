import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Banner, BannerStack } from './Banner';

describe('Banner', () => {
  it('error tone is an alert with an accent square', () => {
    const { container } = render(<Banner tone="error" text="credentials expired" />);
    expect(screen.getByRole('alert')).toHaveTextContent('credentials expired');
    expect(container.querySelector('[data-tone="accent"]')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveAttribute('data-tone', 'error');
  });
  it('info tone is a status with a line square', () => {
    const { container } = render(<Banner tone="info" text="update ready" />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(container.querySelector('[data-tone="line"]')).toBeInTheDocument();
  });
  it('renders the action and dismiss controls and wires callbacks', async () => {
    const onClick = vi.fn();
    const onDismiss = vi.fn();
    render(<Banner text="x" action={{ label: 'Reconnect', onClick }} onDismiss={onDismiss} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
  it('omits controls when not provided', () => {
    render(<Banner text="x" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('dismiss is keyboard reachable', async () => {
    const onDismiss = vi.fn();
    render(<Banner text="x" onDismiss={onDismiss} />);
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
  it('stack renders children in order', () => {
    render(
      <BannerStack data-testid="stack">
        <Banner text="one" />
        <Banner tone="info" text="two" />
      </BannerStack>,
    );
    const stack = screen.getByTestId('stack');
    expect(stack.children).toHaveLength(2);
    expect(stack.children[0]).toHaveTextContent('one');
  });
});

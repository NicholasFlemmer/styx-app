import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NavItem } from './NavItem';

describe('NavItem', () => {
  it('renders label and meta in a button', () => {
    render(<NavItem label="Workspace" meta="3" />);
    const btn = screen.getByRole('button', { name: /Workspace/ });
    expect(btn).toHaveTextContent('3');
    expect(btn).toHaveAttribute('type', 'button');
  });
  it('marks the current item with aria-current and data-inv', () => {
    render(<NavItem label="Agents" inv />);
    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('aria-current', 'page');
    expect(btn).toHaveAttribute('data-inv', 'true');
    expect(btn).not.toHaveAttribute('data-on');
  });
  it('activates on click and Enter', async () => {
    const onClick = vi.fn();
    render(<NavItem label="Repo" onClick={onClick} />);
    await userEvent.click(screen.getByRole('button'));
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(2);
  });
});

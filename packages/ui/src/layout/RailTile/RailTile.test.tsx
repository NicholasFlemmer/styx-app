import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RailTile } from './RailTile';

describe('RailTile', () => {
  it('renders initials with a title tooltip and accessible name', () => {
    render(<RailTile initials="AS" title="acme-shop" />);
    const btn = screen.getByRole('button', { name: 'acme-shop' });
    expect(btn).toHaveTextContent('AS');
    expect(btn).toHaveAttribute('title', 'acme-shop');
    expect(btn).not.toHaveAttribute('data-on');
    expect(btn).not.toHaveAttribute('aria-current');
  });
  it('active → data-on and aria-current', () => {
    render(<RailTile initials="AS" title="acme-shop" active />);
    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('data-on', 'true');
    expect(btn).toHaveAttribute('aria-current', 'true');
  });
  it('needs → corner square and name suffix', () => {
    const { container } = render(<RailTile initials="BV" title="blog-v2" needs />);
    expect(screen.getByRole('button', { name: 'blog-v2 · needs you' })).toBeInTheDocument();
    expect(container.querySelectorAll('span[aria-hidden]')).toHaveLength(1);
  });
  it('add variant renders a plus', async () => {
    const onClick = vi.fn();
    render(<RailTile variant="add" title="New project" onClick={onClick} />);
    const btn = screen.getByRole('button', { name: 'New project' });
    expect(btn).toHaveTextContent('+');
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

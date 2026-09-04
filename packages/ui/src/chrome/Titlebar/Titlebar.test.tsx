import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Titlebar, noDrag } from './Titlebar';

describe('Titlebar', () => {
  it('renders a banner landmark with platform attribute', () => {
    render(<Titlebar platform="win32" left={<span>L</span>} right={<span>R</span>} />);
    const bar = screen.getByRole('banner');
    expect(bar).toHaveAttribute('data-platform', 'win32');
    expect(bar).toHaveTextContent('LR');
  });
  it('defaults to darwin', () => {
    render(<Titlebar />);
    expect(screen.getByRole('banner')).toHaveAttribute('data-platform', 'darwin');
  });
  it('exports a non-empty noDrag class', () => {
    expect(typeof noDrag).toBe('string');
    expect(noDrag.length).toBeGreaterThan(0);
  });
  it('sets data-inv only when true', () => {
    render(<Titlebar inv />);
    expect(screen.getByRole('banner')).toHaveAttribute('data-inv', 'true');
    expect(screen.getByRole('banner')).not.toHaveAttribute('data-on');
  });
});

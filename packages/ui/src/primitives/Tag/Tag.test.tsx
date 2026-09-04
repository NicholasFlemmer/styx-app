import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Tag } from './Tag';

describe('Tag', () => {
  it('renders children and no selection attributes by default', () => {
    render(<Tag>prod</Tag>);
    const el = screen.getByText('prod');
    expect(el.tagName).toBe('SPAN');
    expect(el).not.toHaveAttribute('data-inv');
    expect(el).not.toHaveAttribute('data-on');
    expect(el).toHaveAttribute('data-tone', 'neutral');
  });
  it('accent tone sets data-on', () => {
    render(<Tag tone="accent">prod</Tag>);
    expect(screen.getByText('prod')).toHaveAttribute('data-on', 'true');
  });
  it('inv/on props set data attributes only when true', () => {
    const { rerender } = render(<Tag inv on>x</Tag>);
    expect(screen.getByText('x')).toHaveAttribute('data-inv', 'true');
    expect(screen.getByText('x')).toHaveAttribute('data-on', 'true');
    rerender(<Tag inv={false} on={false}>x</Tag>);
    expect(screen.getByText('x')).not.toHaveAttribute('data-inv');
    expect(screen.getByText('x')).not.toHaveAttribute('data-on');
  });
  it('merges className', () => {
    render(<Tag className="extra">x</Tag>);
    expect(screen.getByText('x')).toHaveClass('extra');
  });
});

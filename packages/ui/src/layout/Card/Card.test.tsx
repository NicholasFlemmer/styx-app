import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Card } from './Card';

const base = { agent: 'Claude', age: '14m', project: 'acme-shop', branch: 'fix/checkout', note: 'Added validation.' };

describe('Card', () => {
  it('renders header, meta, note and actions', () => {
    render(<Card {...base} actions={<button type="button">Open</button>} />);
    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.getByText('14m')).toBeInTheDocument();
    expect(screen.getByText('acme-shop · fix/checkout')).toBeInTheDocument();
    expect(screen.getByText('Added validation.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
  });
  it('defaults to working tone and marks done notes muted', () => {
    const { container, rerender } = render(<Card {...base} />);
    expect(container.firstElementChild).toHaveAttribute('data-tone', 'working');
    expect(screen.getByText('Added validation.')).not.toHaveAttribute('data-muted');
    rerender(<Card {...base} tone="done" />);
    expect(container.firstElementChild).toHaveAttribute('data-tone', 'done');
    expect(screen.getByText('Added validation.')).toHaveAttribute('data-muted', 'true');
  });
  it('sets data-inv only when true', () => {
    const { container } = render(<Card {...base} inv />);
    expect(container.firstElementChild).toHaveAttribute('data-inv', 'true');
    expect(container.firstElementChild).not.toHaveAttribute('data-on');
  });
});

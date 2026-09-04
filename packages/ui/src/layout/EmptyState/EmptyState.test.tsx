import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  it('renders headline, body and actions', () => {
    render(<EmptyState headline="No projects yet." body="Start something new." actions={<button type="button">Scan</button>} />);
    expect(screen.getByText('No projects yet.')).toBeInTheDocument();
    expect(screen.getByText('Start something new.')).toHaveAttribute('data-muted', 'true');
    expect(screen.getByRole('button', { name: 'Scan' })).toBeInTheDocument();
  });
  it('omits body and actions containers when absent', () => {
    const { container } = render(<EmptyState headline="h" />);
    expect(container.firstElementChild?.childElementCount).toBe(1);
  });
});

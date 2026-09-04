import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Wordmark } from './Wordmark';

describe('Wordmark', () => {
  it('renders STYX by default', () => {
    render(<Wordmark />);
    expect(screen.getByText('STYX')).toBeInTheDocument();
  });
  it('sets data-inv only when true', () => {
    render(<Wordmark inv />);
    expect(screen.getByText('STYX')).toHaveAttribute('data-inv', 'true');
    expect(screen.getByText('STYX')).not.toHaveAttribute('data-on');
  });
});

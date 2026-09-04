import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Numeral, formatNumeral } from './Numeral';

describe('formatNumeral', () => {
  it('zero-pads to two digits by default', () => {
    expect(formatNumeral(2)).toBe('02');
    expect(formatNumeral(12)).toBe('12');
    expect(formatNumeral(123)).toBe('123');
  });
  it('honours pad and truncates fractions', () => {
    expect(formatNumeral(7, 0)).toBe('7');
    expect(formatNumeral(7, 3)).toBe('007');
    expect(formatNumeral(7.9)).toBe('07');
    expect(formatNumeral(-3)).toBe('-03');
  });
});

describe('Numeral', () => {
  it('renders the padded value', () => {
    render(<Numeral value={3} />);
    expect(screen.getByText('03')).toBeInTheDocument();
  });
  it('sets data-inv only when true', () => {
    render(<Numeral value={3} inv />);
    expect(screen.getByText('03')).toHaveAttribute('data-inv', 'true');
    expect(screen.getByText('03')).not.toHaveAttribute('data-on');
  });
});

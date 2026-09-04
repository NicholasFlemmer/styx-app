import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Select } from './Select';

const opts = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
];

describe('Select', () => {
  it('renders a native select with options', () => {
    render(<Select aria-label="Theme" options={opts} defaultValue="a" />);
    const sel = screen.getByRole('combobox', { name: 'Theme' });
    expect(sel).toHaveValue('a');
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });
  it('fires onChange when a new option is chosen', async () => {
    const onChange = vi.fn();
    render(<Select aria-label="Theme" options={opts} defaultValue="a" onChange={onChange} />);
    await userEvent.selectOptions(screen.getByRole('combobox'), 'b');
    expect(onChange).toHaveBeenCalled();
    expect(screen.getByRole('combobox')).toHaveValue('b');
  });
  it('applies width to the wrapper', () => {
    const { container } = render(<Select aria-label="x" options={opts} width={170} />);
    expect(container.firstElementChild).toHaveStyle({ width: '170px' });
  });
  it('accepts option children', () => {
    render(
      <Select aria-label="x">
        <option value="z">Zed</option>
      </Select>,
    );
    expect(screen.getByRole('option', { name: 'Zed' })).toBeInTheDocument();
  });
});

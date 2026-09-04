import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChipGroup } from './ChipGroup';

const opts = [
  { value: 'once', label: 'once' },
  { value: '1h', label: '1h' },
  { value: 'session', label: 'session' },
  { value: 'always', label: 'always' },
];

describe('ChipGroup', () => {
  it('renders a radiogroup with one checked radio', () => {
    render(<ChipGroup aria-label="Duration" options={opts} value="1h" onChange={() => {}} />);
    expect(screen.getByRole('radiogroup', { name: 'Duration' })).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(4);
    expect(screen.getByRole('radio', { name: '1h' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '1h' })).toHaveAttribute('data-on', 'true');
    expect(screen.getByRole('radio', { name: 'once' })).not.toHaveAttribute('data-on');
  });
  it('clicking a chip calls onChange', async () => {
    const onChange = vi.fn();
    render(<ChipGroup aria-label="d" options={opts} value="1h" onChange={onChange} />);
    await userEvent.click(screen.getByRole('radio', { name: 'always' }));
    expect(onChange).toHaveBeenCalledWith('always');
  });
  it('only the chosen chip is tabbable; arrow keys move and select', async () => {
    const onChange = vi.fn();
    render(<ChipGroup aria-label="d" options={opts} value="1h" onChange={onChange} />);
    await userEvent.tab();
    expect(screen.getByRole('radio', { name: '1h' })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('session');
    expect(screen.getByRole('radio', { name: 'session' })).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(onChange).toHaveBeenLastCalledWith('once');
    expect(screen.getByRole('radio', { name: 'once' })).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(onChange).toHaveBeenLastCalledWith('always');
    await userEvent.keyboard('{Home}');
    expect(onChange).toHaveBeenLastCalledWith('once');
    await userEvent.keyboard('{End}');
    expect(onChange).toHaveBeenLastCalledWith('always');
  });
  it('first enabled chip is tabbable when nothing is chosen', async () => {
    render(<ChipGroup aria-label="d" options={opts} value={null} onChange={() => {}} />);
    await userEvent.tab();
    expect(screen.getByRole('radio', { name: 'once' })).toHaveFocus();
  });
  it('skips disabled chips when moving', async () => {
    const onChange = vi.fn();
    const withDisabled = [opts[0]!, { ...opts[1]!, disabled: true }, opts[2]!, opts[3]!];
    render(<ChipGroup aria-label="d" options={withDisabled} value="once" onChange={onChange} />);
    await userEvent.tab();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('session');
  });
  it('grid layout sets one column per option', () => {
    render(<ChipGroup aria-label="d" options={opts} value="once" onChange={() => {}} />);
    expect(screen.getByRole('radiogroup')).toHaveStyle({ gridTemplateColumns: 'repeat(4, 1fr)' });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Checkbox } from './Checkbox';

describe('Checkbox', () => {
  it('renders a native checkbox labelled by the row text', () => {
    render(<Checkbox checked={false} label="Import theme" />);
    const cb = screen.getByRole('checkbox', { name: 'Import theme' });
    expect(cb).not.toBeChecked();
  });
  it('toggles when the label text is clicked (whole row hit target)', async () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} label="git init" />);
    await userEvent.click(screen.getByText('git init'));
    expect(onChange).toHaveBeenCalledWith(true);
  });
  it('toggles with Space from the keyboard', async () => {
    const onChange = vi.fn();
    render(<Checkbox checked label="Write" onChange={onChange} />);
    await userEvent.tab();
    expect(screen.getByRole('checkbox')).toHaveFocus();
    await userEvent.keyboard(' ');
    expect(onChange).toHaveBeenCalledWith(false);
  });
  it('accent tone marks the box data-on only when checked', () => {
    const { container, rerender } = render(<Checkbox checked tone="accent" size={16} label="p" />);
    const box = container.querySelector('span[aria-hidden]');
    expect(box).toHaveAttribute('data-on', 'true');
    rerender(<Checkbox checked={false} tone="accent" size={16} label="p" />);
    expect(container.querySelector('span[aria-hidden]')).not.toHaveAttribute('data-on');
  });
  it('inverted tone never sets data-on on the box', () => {
    const { container } = render(<Checkbox checked label="p" />);
    expect(container.querySelector('span[aria-hidden]')).not.toHaveAttribute('data-on');
  });
  it('disabled blocks interaction', async () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} disabled onChange={onChange} label="x" />);
    expect(screen.getByRole('checkbox')).toBeDisabled();
  });
  it('sets row data-inv/data-on only when true', () => {
    const { container } = render(<Checkbox checked={false} inv label="x" />);
    expect(container.firstElementChild).toHaveAttribute('data-inv', 'true');
    expect(container.firstElementChild).not.toHaveAttribute('data-on');
  });
});

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Input } from './Input';

describe('Input', () => {
  it('renders a text input that accepts typing', async () => {
    render(<Input aria-label="Name" />);
    const input = screen.getByRole('textbox', { name: 'Name' });
    await userEvent.type(input, 'orders');
    expect(input).toHaveValue('orders');
  });
  it('masked renders a password field', () => {
    render(<Input aria-label="Secret" masked />);
    expect(screen.getByLabelText('Secret')).toHaveAttribute('type', 'password');
  });
  it('renders the trailing node inside the wrapper', () => {
    render(<Input aria-label="Key" trailing={<button type="button">Browse</button>} />);
    expect(screen.getByRole('button', { name: 'Browse' })).toBeInTheDocument();
  });
  it('forwards disabled and wrapper className', () => {
    const { container } = render(<Input aria-label="x" disabled className="extra" />);
    expect(screen.getByLabelText('x')).toBeDisabled();
    expect(container.firstElementChild).toHaveClass('extra');
  });
  it('sets data-on/data-inv on the wrapper only when true', () => {
    const { container } = render(<Input aria-label="x" on />);
    expect(container.firstElementChild).toHaveAttribute('data-on', 'true');
    expect(container.firstElementChild).not.toHaveAttribute('data-inv');
  });
});

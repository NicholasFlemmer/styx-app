import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Backdrop } from './Backdrop';

afterEach(cleanup);

describe('Backdrop', () => {
  it('closes on a click on the dim but not on the panel', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Backdrop onClose={onClose} data-testid="dim">
        <div>panel</div>
      </Backdrop>,
    );
    await user.click(screen.getByText('panel'));
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('dim'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('applies paddingTop', () => {
    render(<Backdrop paddingTop={110} data-testid="dim" />);
    expect(screen.getByTestId('dim')).toHaveStyle({ paddingTop: '110px' });
  });
});

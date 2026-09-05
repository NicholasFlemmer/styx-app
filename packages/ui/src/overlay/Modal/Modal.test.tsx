import { useState } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from '../../primitives';
import { Modal } from './Modal';

afterEach(cleanup);

function Host({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>open</button>
      {open && (
        <Modal
          title="Spawn agent"
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          footer={
            <>
              <Button size="footer">Cancel</Button>
              <Button size="footer" variant="primary">
                Spawn
              </Button>
            </>
          }
        >
          <input aria-label="Branch" />
        </Modal>
      )}
    </>
  );
}

describe('Modal', () => {
  it('has dialog semantics labelled by the title', () => {
    render(<Modal title="Connect target" onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Connect target');
  });

  it('focuses the first tabbable and traps Tab', async () => {
    const user = userEvent.setup();
    render(<Host />);
    await user.click(screen.getByText('open'));
    expect(screen.getByLabelText('Close')).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText('Branch')).toHaveFocus();
    await user.tab();
    await user.tab();
    expect(screen.getByText('Spawn')).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText('Close')).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByText('Spawn')).toHaveFocus();
  });

  it('closes on Esc, on backdrop click, and on the ✕ button; returns focus to the invoker', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    const opener = screen.getByText('open');

    await user.click(opener);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(opener).toHaveFocus());

    await user.click(opener);
    await user.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(2);

    await user.click(opener);
    const dim = screen.getByRole('dialog').parentElement;
    if (!dim) throw new Error('no backdrop');
    await user.click(dim);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('does not close on a click inside the panel', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal title="T" onClose={onClose}>
        <p>body</p>
      </Modal>,
    );
    await user.click(screen.getByText('body'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('anchors the backdrop at 90px by default and 70px for top={70}', () => {
    const { unmount } = render(<Modal title="Connect" onClose={() => {}} />);
    expect(screen.getByRole('dialog').parentElement).toHaveStyle({ paddingTop: '90px' });
    unmount();
    render(<Modal title="New project" top={70} onClose={() => {}} />);
    expect(screen.getByRole('dialog').parentElement).toHaveStyle({ paddingTop: '70px' });
  });

  it('ignores Esc when escapeEnabled is false', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Modal title="T" onClose={onClose} escapeEnabled={false} />);
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });
});

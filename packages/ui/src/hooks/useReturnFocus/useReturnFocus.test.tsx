import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useReturnFocus } from './useReturnFocus';

function Overlay() {
  useReturnFocus(true);
  return <button autoFocus>inside</button>;
}

function Host() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>invoker</button>
      {open && (
        <div>
          <Overlay />
          <button onClick={() => setOpen(false)}>close</button>
        </div>
      )}
    </>
  );
}

describe('useReturnFocus', () => {
  it('restores focus to the invoker after the overlay unmounts', async () => {
    const user = userEvent.setup();
    render(<Host />);
    const invoker = screen.getByText('invoker');
    await user.click(invoker);
    expect(screen.getByText('inside')).toHaveFocus();
    await user.click(screen.getByText('close'));
    await waitFor(() => expect(invoker).toHaveFocus());
  });

  it('does not restore when the invoker is no longer connected', async () => {
    function Detach() {
      const [open, setOpen] = useState(false);
      const [showInvoker, setShowInvoker] = useState(true);
      return (
        <>
          {showInvoker && <button onClick={() => setOpen(true)}>invoker</button>}
          <button
            onClick={() => {
              setShowInvoker(false);
              setOpen(false);
            }}
          >
            close-and-remove
          </button>
          {open && <Overlay />}
        </>
      );
    }
    const user = userEvent.setup();
    render(<Detach />);
    await user.click(screen.getByText('invoker'));
    const closer = screen.getByText('close-and-remove');
    await user.click(closer);
    await new Promise((r) => setTimeout(r, 30));
    expect(closer).toHaveFocus();
  });
});

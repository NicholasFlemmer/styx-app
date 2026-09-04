import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../../primitives';
import { Sheet, SheetAccentHeader, SheetFooter } from './Sheet';

function Host({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>review</button>
      {open && (
        <Sheet
          header={<SheetAccentHeader label="Access request" meta="Codex · test/flaky" />}
          title="Supabase / prod db"
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          footer={
            <SheetFooter>
              <Button size="footer">Deny</Button>
              <Button size="footer" variant="accent" grow={1.4}>
                Grant
              </Button>
            </SheetFooter>
          }
        >
          <button>Read schema</button>
        </Sheet>
      )}
    </>
  );
}

describe('Sheet', () => {
  it('is a dialog labelled by its title with the accent header text', () => {
    render(<Host />);
    return (async () => {
      await userEvent.setup().click(screen.getByText('review'));
      expect(screen.getByRole('dialog')).toHaveAccessibleName('Supabase / prod db');
      expect(screen.getByText('Access request')).toBeInTheDocument();
      expect(screen.getByText('Codex · test/flaky')).toBeInTheDocument();
    })();
  });

  it('traps focus among body and footer buttons', async () => {
    const user = userEvent.setup();
    render(<Host />);
    await user.click(screen.getByText('review'));
    expect(screen.getByText('Read schema')).toHaveFocus();
    await user.tab();
    await user.tab();
    expect(screen.getByText('Grant')).toHaveFocus();
    await user.tab();
    expect(screen.getByText('Read schema')).toHaveFocus();
  });

  it('closes on Esc and returns focus to the invoker', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    const opener = screen.getByText('review');
    await user.click(opener);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('only the topmost overlay handles Esc when nested', async () => {
    const user = userEvent.setup();
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <Sheet title="outer" onClose={outer}>
        <Sheet title="inner" onClose={inner} />
      </Sheet>,
    );
    await user.keyboard('{Escape}');
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });
});

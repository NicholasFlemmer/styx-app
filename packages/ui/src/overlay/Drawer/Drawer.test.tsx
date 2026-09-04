import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../../primitives';
import { Drawer, DrawerRow } from './Drawer';

describe('Drawer', () => {
  it('is a dialog labelled by the heading with rows and footer', () => {
    render(
      <Drawer heading="Audit entry" title="Granted Codex write" meta="14:02" onClose={() => {}} footer={<Button size="footer">Copy JSON</Button>}>
        <DrawerRow label="Actor">codex</DrawerRow>
        <DrawerRow label="Target">supabase-prod</DrawerRow>
      </Drawer>,
    );
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Audit entry');
    expect(screen.getByText('Actor')).toBeInTheDocument();
    expect(screen.getByText('supabase-prod')).toBeInTheDocument();
    expect(screen.getByText('Copy JSON')).toBeInTheDocument();
  });

  it('closes via ✕ and Esc', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Drawer heading="Audit entry" onClose={onClose}>
        <DrawerRow label="Actor">codex</DrawerRow>
      </Drawer>,
    );
    expect(screen.getByLabelText('Close')).toHaveFocus();
    await user.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('traps Tab within the drawer', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button>outside</button>
        <Drawer heading="Audit entry" onClose={() => {}} footer={<Button size="footer">Revoke now</Button>} />
      </>,
    );
    await user.tab();
    expect(screen.getByText('Revoke now')).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText('Close')).toHaveFocus();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TitlebarField } from './TitlebarField';

describe('TitlebarField', () => {
  it('is a labelled button showing the mac hint by default', () => {
    render(<TitlebarField />);
    const btn = screen.getByRole('button', { name: 'Open command palette' });
    expect(btn).toHaveTextContent('Switch, spawn, deploy, grant…');
    expect(btn).toHaveTextContent('⌘K');
    expect(btn).toHaveAttribute('aria-keyshortcuts', 'Meta+K');
  });
  it('shows the Ctrl K hint on win32', () => {
    render(<TitlebarField platform="win32" />);
    expect(screen.getByRole('button')).toHaveTextContent('Ctrl K');
    expect(screen.getByRole('button')).toHaveAttribute('aria-keyshortcuts', 'Control+K');
  });
  it('opens on click and keyboard', async () => {
    const onClick = vi.fn();
    render(<TitlebarField onClick={onClick} />);
    await userEvent.click(screen.getByRole('button'));
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(2);
  });
  it('allows overriding the aria-label', () => {
    render(<TitlebarField aria-label="Palette" />);
    expect(screen.getByRole('button', { name: 'Palette' })).toBeInTheDocument();
  });
});

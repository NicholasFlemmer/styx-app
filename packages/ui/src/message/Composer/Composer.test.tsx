import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';

describe('Composer', () => {
  it('⏎ sends trimmed text and clears; ⇧⏎ inserts a newline', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer placeholder="Message Claude…" onSend={onSend} />);
    const box = screen.getByPlaceholderText('Message Claude…');
    await user.click(box);
    await user.keyboard('line one{Shift>}{Enter}{/Shift}line two');
    expect(box).toHaveValue('line one\nline two');
    expect(onSend).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledWith('line one\nline two');
    expect(box).toHaveValue('');
    expect(box).toHaveFocus();
  });

  it('does not send empty text', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    await user.click(screen.getByRole('textbox'));
    await user.keyboard('   {Enter}');
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '⏎ send' })).toBeDisabled();
  });

  it('renders hints, the model control, and the send button', async () => {
    const user = userEvent.setup();
    const onModel = vi.fn();
    const onSend = vi.fn();
    render(<Composer onSend={onSend} onModel={onModel} modelLabel="Model" />);
    expect(screen.getByText('@file')).toBeInTheDocument();
    expect(screen.getByText('/command')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Model' }));
    expect(onModel).toHaveBeenCalledTimes(1);
    await user.type(screen.getByRole('textbox'), 'go');
    await user.click(screen.getByRole('button', { name: '⏎ send' }));
    expect(onSend).toHaveBeenCalledWith('go');
  });

  it('compact hides the hint row', () => {
    render(<Composer onSend={() => {}} compact />);
    expect(screen.queryByText('@file')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });
});

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';

afterEach(cleanup);

const strings = { placeholder: 'Message…', hints: ['@file', '/command'], sendLabel: '⏎ send' } as const;

describe('Composer', () => {
  it('⏎ sends trimmed text and clears; ⇧⏎ inserts a newline', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer {...strings} placeholder="Message Claude…" onSend={onSend} />);
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
    render(<Composer {...strings} onSend={onSend} />);
    await user.click(screen.getByRole('textbox'));
    await user.keyboard('   {Enter}');
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '⏎ send' })).toBeDisabled();
  });

  it('renders hints, the model control, and the send button', async () => {
    const user = userEvent.setup();
    const onModel = vi.fn();
    const onSend = vi.fn();
    render(<Composer {...strings} onSend={onSend} onModel={onModel} modelLabel="Model" />);
    expect(screen.getByText('@file')).toBeInTheDocument();
    expect(screen.getByText('/command')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Model' }));
    expect(onModel).toHaveBeenCalledTimes(1);
    await user.type(screen.getByRole('textbox'), 'go');
    await user.click(screen.getByRole('button', { name: '⏎ send' }));
    expect(onSend).toHaveBeenCalledWith('go');
  });

  it('controls slot replaces the model control and sits before the send button', () => {
    const onModel = vi.fn();
    render(
      <Composer
        {...strings}
        onSend={() => {}}
        onModel={onModel}
        modelLabel="Model"
        controls={<button type="button">Stop · esc</button>}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Model' })).not.toBeInTheDocument();
    const stop = screen.getByRole('button', { name: 'Stop · esc' });
    const send = screen.getByRole('button', { name: '⏎ send' });
    expect(stop.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(stop.closest('[data-composer-controls="true"]')).not.toBeNull();
  });

  it('compact hides the hint row', () => {
    render(<Composer {...strings} onSend={() => {}} compact />);
    expect(screen.queryByText('@file')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('prefill puts text back into the draft once per seq, after what is already typed, and focuses the box', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Composer {...strings} onSend={() => {}} prefill={null} />);
    const box = screen.getByRole('textbox');
    rerender(<Composer {...strings} onSend={() => {}} prefill={{ text: 'taken back', seq: 1 }} />);
    expect(box).toHaveValue('taken back');
    expect(box).toHaveFocus();
    expect((box as HTMLTextAreaElement).selectionStart).toBe('taken back'.length);
    // The same prefill again (a re-render, the host clearing it) does not apply twice.
    rerender(<Composer {...strings} onSend={() => {}} prefill={{ text: 'taken back', seq: 1 }} />);
    rerender(<Composer {...strings} onSend={() => {}} prefill={null} />);
    expect(box).toHaveValue('taken back');
    // A new one lands after the current draft, separated by a blank line: nothing typed is lost.
    await user.type(box, ' and more');
    rerender(<Composer {...strings} onSend={() => {}} prefill={{ text: 'second', seq: 2 }} />);
    expect(box).toHaveValue('taken back and more\n\nsecond');
    expect(screen.getByRole('button', { name: '⏎ send' })).toBeEnabled();
  });

  it('initialText seeds the draft and onTextChange reports typing, a prefill, and the clear after send', async () => {
    const user = userEvent.setup();
    const reported: string[] = [];
    const onSend = vi.fn();
    const { rerender } = render(
      <Composer {...strings} onSend={onSend} initialText="kept" onTextChange={(t) => reported.push(t)} />,
    );
    const box = screen.getByRole('textbox');
    expect(box).toHaveValue('kept');
    await user.type(box, ' on');
    rerender(
      <Composer
        {...strings}
        onSend={onSend}
        initialText="kept"
        onTextChange={(t) => reported.push(t)}
        prefill={{ text: 'back', seq: 1 }}
      />,
    );
    expect(box).toHaveValue('kept on\n\nback');
    await user.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledWith('kept on\n\nback');
    expect(box).toHaveValue('');
    expect(reported.at(0)).toBe('kept');
    expect(reported).toContain('kept on\n\nback');
    expect(reported.at(-1)).toBe('');
  });

  it('sendTitle is the send button tooltip (the queue / steer hint mid-turn)', () => {
    render(
      <Composer
        {...strings}
        onSend={() => {}}
        sendLabel="Queue"
        sendTitle="Claude Code takes it after this turn."
      />,
    );
    const send = screen.getByRole('button', { name: 'Queue' });
    expect(send).toHaveAttribute('title', 'Claude Code takes it after this turn.');
    expect(send).toHaveAttribute('data-composer-send', 'true');
  });
});

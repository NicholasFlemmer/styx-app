// @vitest-environment jsdom
import { copy, fixtures, type ReadModel } from '@styx/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { FeedbackModal } from './FeedbackModal';

type Result = { ok: true; value: object } | { ok: false; error: { code: string; message: string } };
const commandMock = vi.fn(async (_name: string, _input: unknown): Promise<Result> => ({
  ok: true,
  value: {},
}));

const signedIn = (): ReadModel => {
  const m = fixtures.demoReadModel();
  return {
    ...m,
    account: {
      kind: 'signed-in',
      account: {
        id: 'acct_1',
        email: 'dev@example.com',
        name: 'Dev',
        avatarUrl: null,
        provider: 'github',
        plan: 'free',
        planUntil: null,
      },
      signedInAt: 0,
      staleSince: null,
    },
  } as ReadModel;
};

describe('FeedbackModal (#123)', () => {
  beforeEach(() => {
    commandMock.mockClear();
    Object.assign(window, { styx: { platform: 'darwin', env: {}, command: commandMock } });
    useUiStore.setState({ overlays: [{ id: 'fb', kind: 'modal', modal: 'feedback' }], platform: 'darwin' });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('Send waits for words, then sends them with the typed email and says thank you', async () => {
    render(<FeedbackModal id="fb" />);
    const send = screen.getByRole('button', { name: copy.feedback.send });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(copy.feedback.message), {
      target: { value: '  Love the board  ' },
    });
    fireEvent.change(screen.getByLabelText(copy.feedback.email), { target: { value: 'me@example.com' } });
    fireEvent.click(send);
    await waitFor(() => expect(screen.getByText(copy.feedback.sent)).toBeTruthy());
    expect(commandMock).toHaveBeenCalledWith('feedback.send', {
      message: 'Love the board',
      email: 'me@example.com',
    });
    const done = document.querySelector('[data-feedback-close]');
    if (done === null) throw new Error('close button');
    fireEvent.click(done);
    expect(useUiStore.getState().overlays).toEqual([]);
  });

  it('fills in the account email when signed in, and ⌘⏎ sends', async () => {
    useReadModel.getState().replaceModel(signedIn(), 'connected');
    render(<FeedbackModal id="fb" />);
    expect((screen.getByLabelText(copy.feedback.email) as HTMLInputElement).value).toBe('dev@example.com');
    const box = screen.getByLabelText(copy.feedback.message);
    fireEvent.change(box, { target: { value: 'Needs Windows' } });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() =>
      expect(commandMock).toHaveBeenCalledWith('feedback.send', {
        message: 'Needs Windows',
        email: 'dev@example.com',
      }),
    );
  });

  it('a failure keeps the message and says why, with the email address to fall back on', async () => {
    commandMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'provider-error', message: 'Styx could not reach its server; check your connection' },
    });
    render(<FeedbackModal id="fb" />);
    fireEvent.change(screen.getByLabelText(copy.feedback.message), { target: { value: 'Offline test' } });
    fireEvent.click(screen.getByRole('button', { name: copy.feedback.send }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'Could not send it: Styx could not reach its server; check your connection. Try again, or email hello@heystyx.com.',
    );
    expect((screen.getByLabelText(copy.feedback.message) as HTMLTextAreaElement).value).toBe('Offline test');
  });
});

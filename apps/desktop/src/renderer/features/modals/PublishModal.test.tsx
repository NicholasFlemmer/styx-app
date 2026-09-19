// @vitest-environment jsdom
import { copy, fixtures, type WorktreeId } from '@styx/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { defaultThrough, PublishModal, splitMessage } from './PublishModal';

const { ids } = fixtures;
const testFlaky = ids.worktree.testFlaky as WorktreeId;
const fixCheckout = ids.worktree.fixCheckout as WorktreeId;

/** Default answers: drafts resolve at once; publish steps succeed (commit → sha, push → pushed, pr → #7). */
const answer = async (name: string, input?: unknown): Promise<unknown> => {
  if (name === 'worktree.generateMessage') {
    const { kind } = input as { kind: 'commit' | 'pr' };
    return kind === 'commit'
      ? { ok: true, value: { title: 'Validate the cart', body: 'Adds validate.ts.' } }
      : { ok: true, value: { title: 'Add cart validation', body: '## Summary\n- validate.ts' } };
  }
  if (name === 'worktree.publish') {
    const { through } = input as { through: 'commit' | 'push' | 'pr' };
    return {
      ok: true,
      value: {
        commit: through === 'commit' ? 'abcdef1234567890' : null,
        pushed: through !== 'commit',
        pr: through === 'pr' ? { number: 7, url: 'https://github.com/acme/shop/pull/7' } : null,
      },
    };
  }
  return { ok: true, value: {} };
};
const commandMock = vi.fn(answer);
const calls = (name: string) =>
  commandMock.mock.calls.filter((c) => (c as unknown[])[0] === name).map((c) => (c as unknown[])[1]);

const dialog = () => screen.getByRole('dialog');
const stepLine = (step: string) => document.querySelector<HTMLElement>(`[data-publish-step="${step}"]`);

describe('PublishModal', () => {
  beforeEach(() => {
    commandMock.mockReset();
    commandMock.mockImplementation(answer);
    Object.assign(window, { styx: { platform: 'darwin', env: {}, command: commandMock } });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({
      overlays: [{ id: 'modal-1', kind: 'modal', modal: 'publish', worktreeId: testFlaky }],
      platform: 'darwin',
      projectId: ids.project.acmeShop,
    });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('helpers: the reach defaults to PR without an open one, push with one, push on main; the message splits on its first line', () => {
    expect(defaultThrough(null)).toBe('push');
    expect(defaultThrough({ isMain: true, pr: null })).toBe('push');
    expect(defaultThrough({ isMain: false, pr: null })).toBe('pr');
    expect(defaultThrough({ isMain: false, pr: { number: 1, state: 'open', url: null } })).toBe('push');
    expect(defaultThrough({ isMain: false, pr: { number: 1, state: 'draft', url: null } })).toBe('push');
    expect(defaultThrough({ isMain: false, pr: { number: 1, state: 'merged', url: null } })).toBe('pr');
    expect(splitMessage('  Title \n\nbody line\nmore\n')).toEqual({
      title: 'Title',
      body: 'body line\nmore',
    });
    expect(splitMessage('')).toEqual({ title: '', body: '' });
  });

  it('drafts the commit message and, for a lane without a PR, the PR title and description; the lead names the agent', async () => {
    render(<PublishModal id="modal-1" worktreeId={testFlaky} />);
    expect(screen.getByRole('dialog', { name: 'Publish · test/flaky' })).toBeTruthy();
    expect(within(dialog()).getByText(/drafted by Claude Code/)).toBeTruthy();
    const message = within(dialog()).getByLabelText(copy.publish.messageLabel) as HTMLTextAreaElement;
    await waitFor(() => expect(message.value).toBe('Validate the cart\n\nAdds validate.ts.'));
    // No open PR: the reach is "…& open PR" and the PR fields are drafted too.
    const pr = within(dialog()).getByRole('radio', { name: copy.publish.through.pr });
    expect(pr.getAttribute('aria-checked')).toBe('true');
    const title = within(dialog()).getByLabelText(copy.publish.prTitleLabel) as HTMLInputElement;
    await waitFor(() => expect(title.value).toBe('Add cart validation'));
    expect((within(dialog()).getByLabelText(copy.publish.prBodyLabel) as HTMLTextAreaElement).value).toBe(
      '## Summary\n- validate.ts',
    );
    expect(calls('worktree.generateMessage')).toEqual([
      { worktreeId: testFlaky, kind: 'commit' },
      { worktreeId: testFlaky, kind: 'pr' },
    ]);
    // Commit only hides the PR fields; nothing is re-drafted when the reach comes back.
    fireEvent.click(within(dialog()).getByRole('radio', { name: copy.publish.through.commit }));
    expect(within(dialog()).queryByLabelText(copy.publish.prTitleLabel)).toBeNull();
    fireEvent.click(within(dialog()).getByRole('radio', { name: copy.publish.through.pr }));
    expect((within(dialog()).getByLabelText(copy.publish.prTitleLabel) as HTMLInputElement).value).toBe(
      'Add cart validation',
    );
    expect(calls('worktree.generateMessage')).toHaveLength(2);
  });

  it('shows "Drafting…" while the agent works and the failure text with an empty field when it cannot', async () => {
    let release: ((v: unknown) => void) | null = null;
    commandMock.mockImplementation(
      (name: string) =>
        new Promise((resolve) => {
          if (name === 'worktree.generateMessage') release = resolve;
          else resolve({ ok: true, value: {} });
        }),
    );
    render(<PublishModal id="modal-1" worktreeId={fixCheckout} />);
    expect(within(dialog()).getByText(copy.publish.generating)).toBeTruthy();
    // Publish stays off until there is a message to send.
    expect((screen.getByRole('button', { name: copy.publish.run }) as HTMLButtonElement).disabled).toBe(true);
    (release as unknown as (v: unknown) => void)({
      ok: false,
      error: { code: 'internal', message: 'claude timed out' },
    });
    await waitFor(() =>
      expect(
        within(dialog()).getByText('Could not draft a message: claude timed out. Write one below.'),
      ).toBeTruthy(),
    );
    const message = within(dialog()).getByLabelText(copy.publish.messageLabel) as HTMLTextAreaElement;
    expect(message.value).toBe('');
    fireEvent.change(message, { target: { value: 'My own message' } });
    expect((screen.getByRole('button', { name: copy.publish.run }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('a late draft never overwrites what the user typed', async () => {
    let release: ((v: unknown) => void) | null = null;
    commandMock.mockImplementation(
      (name: string, input?: unknown) =>
        new Promise((resolve) => {
          if (name === 'worktree.generateMessage' && (input as { kind: string }).kind === 'commit')
            release = resolve;
          else void answer(name, input).then(resolve);
        }),
    );
    render(<PublishModal id="modal-1" worktreeId={fixCheckout} />);
    const message = within(dialog()).getByLabelText(copy.publish.messageLabel) as HTMLTextAreaElement;
    fireEvent.change(message, { target: { value: 'Typed first' } });
    (release as unknown as (v: unknown) => void)({ ok: true, value: { title: 'Late', body: '' } });
    await waitFor(() => expect(within(dialog()).queryByText(copy.publish.generating)).toBeNull());
    expect(message.value).toBe('Typed first');
  });

  it('Publish runs commit → push → PR as successive worktree.publish calls, reports each step, and offers the PR', async () => {
    render(<PublishModal id="modal-1" worktreeId={testFlaky} />);
    await waitFor(() =>
      expect((within(dialog()).getByLabelText(copy.publish.prTitleLabel) as HTMLInputElement).value).toBe(
        'Add cart validation',
      ),
    );
    fireEvent.click(within(dialog()).getByRole('checkbox', { name: copy.publish.draft }));
    fireEvent.click(screen.getByRole('button', { name: copy.publish.run }));
    await waitFor(() => expect(stepLine('pr')?.getAttribute('data-state')).toBe('done'));
    expect(stepLine('commit')?.textContent).toBe('Committed abcdef1');
    expect(stepLine('push')?.textContent).toBe('Pushed test/flaky');
    expect(stepLine('pr')?.textContent).toBe('Opened PR #7');
    expect(calls('worktree.publish')).toEqual([
      {
        worktreeId: testFlaky,
        through: 'commit',
        message: { title: 'Validate the cart', body: 'Adds validate.ts.' },
        draft: true,
      },
      {
        worktreeId: testFlaky,
        through: 'push',
        message: { title: 'Validate the cart', body: 'Adds validate.ts.' },
        draft: true,
      },
      {
        worktreeId: testFlaky,
        through: 'pr',
        message: { title: 'Add cart validation', body: '## Summary\n- validate.ts' },
        draft: true,
      },
    ]);
    // The form is gone; the footer offers the PR and Close.
    expect(within(dialog()).queryByLabelText(copy.publish.messageLabel)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open PR #7' }));
    expect(calls('link.open')).toEqual([{ url: 'https://github.com/acme/shop/pull/7' }]);
    fireEvent.click(document.querySelector('[data-publish-close]') as HTMLElement);
    expect(useUiStore.getState().overlays).toHaveLength(0);
  });

  it('a clean tree reads "Nothing to commit"; an already-open PR reads "already exists"', async () => {
    commandMock.mockImplementation(async (name: string, input?: unknown) => {
      if (name !== 'worktree.publish') return answer(name, input);
      const { through } = input as { through: string };
      return {
        ok: true,
        value: {
          commit: null,
          pushed: true,
          pr: through === 'pr' ? { number: 214, url: 'https://github.com/acme/shop/pull/214' } : null,
        },
      };
    });
    // fix/checkout already has draft #214: the reach defaults to commit & push; pick the PR anyway.
    render(<PublishModal id="modal-1" worktreeId={fixCheckout} />);
    expect(
      within(dialog()).getByRole('radio', { name: copy.publish.through.push }).getAttribute('aria-checked'),
    ).toBe('true');
    fireEvent.click(within(dialog()).getByRole('radio', { name: copy.publish.through.pr }));
    await waitFor(() =>
      expect((within(dialog()).getByLabelText(copy.publish.prTitleLabel) as HTMLInputElement).value).toBe(
        'Add cart validation',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: copy.publish.run }));
    await waitFor(() => expect(stepLine('pr')?.getAttribute('data-state')).toBe('done'));
    expect(stepLine('commit')?.textContent).toBe(copy.publish.nothingToCommit);
    expect(stepLine('pr')?.textContent).toBe('PR #214 already exists for this branch.');
  });

  it('a failing step stops the run and says which step failed', async () => {
    commandMock.mockImplementation(async (name: string, input?: unknown) => {
      if (name === 'worktree.publish' && (input as { through: string }).through === 'push')
        return { ok: false, error: { code: 'invalid-input', message: copy.publish.noRemote } };
      return answer(name, input);
    });
    render(<PublishModal id="modal-1" worktreeId={testFlaky} />);
    await waitFor(() =>
      expect(
        (within(dialog()).getByLabelText(copy.publish.messageLabel) as HTMLTextAreaElement).value,
      ).not.toBe(''),
    );
    fireEvent.click(screen.getByRole('button', { name: copy.publish.run }));
    await waitFor(() => expect(stepLine('push')?.getAttribute('data-state')).toBe('failed'));
    expect(within(dialog()).getByRole('alert').textContent).toBe(
      'Commit & push failed: No remote: add one under Repo before pushing.',
    );
    expect(stepLine('pr')).toBeNull();
    expect(calls('worktree.publish')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Open PR/ })).toBeNull();
    expect(document.querySelector('[data-publish-close]')).toBeTruthy();
  });

  it('main can commit and push but the PR chip is disabled', () => {
    render(<PublishModal id="modal-1" worktreeId={ids.worktree.acmeMain as WorktreeId} />);
    const pr = within(dialog()).getByRole('radio', { name: copy.publish.through.pr }) as HTMLButtonElement;
    expect(pr.disabled).toBe(true);
    expect(
      within(dialog()).getByRole('radio', { name: copy.publish.through.push }).getAttribute('aria-checked'),
    ).toBe('true');
  });
});

// @vitest-environment jsdom
import { copy, fixtures, type Checkpoint, type ProjectId, type ReadModel, type SessionId } from '@styx/core';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { ChangesPage } from './ChangesPage';

const acme = fixtures.ids.project.acmeShop as ProjectId;
const claude = fixtures.ids.session.claude as SessionId;

const cp = (over: Partial<Checkpoint>): Checkpoint => ({
  id: 'cp-1',
  sessionId: claude,
  worktreeId: fixtures.ids.worktree.fixCheckout as Checkpoint['worktreeId'],
  turn: 1,
  messageId: null,
  baseRef: 'b',
  ref: 'r',
  files: 1,
  added: 2,
  removed: 0,
  createdAt: 0,
  settledAt: 1,
  revertedAt: null,
  screens: [],
  ...over,
});
const withCheckpoints = (list: Checkpoint[], state: 'idle' | 'working' = 'idle'): ReadModel => {
  const m = fixtures.demoReadModel();
  const s = m.sessions.byId[claude];
  if (s === undefined) throw new Error('fixture');
  return {
    ...m,
    sessions: { ...m.sessions, byId: { ...m.sessions.byId, [claude]: { ...s, state } } },
    checkpoints: { ...m.checkpoints, [claude]: list },
  };
};
const PATCH = 'diff --git a/notes.txt b/notes.txt\n--- a/notes.txt\n+++ b/notes.txt\n@@ -0,0 +1 @@\n+hi\n';
const commands: { name: string; input: unknown }[] = [];

describe('ChangesPage (ADR-0027 §3)', () => {
  beforeEach(() => {
    commands.length = 0;
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: fixtures.DEMO_NOW },
        command: vi.fn(async (name: string, input: unknown) => {
          commands.push({ name, input });
          if (name === 'checkpoint.diff') return { ok: true, value: { patch: PATCH } };
          return { ok: true, value: {} };
        }),
      },
    });
    useUiStore.setState({ overlays: [], screen: 'workspace', projectId: acme, projectSession: {} });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('reads the lane as a page: state, task, every turn; Show fetches a turn’s diff, Undo asks then reverts', async () => {
    useReadModel
      .getState()
      .replaceModel(withCheckpoints([cp({ id: 'cp-1' }), cp({ id: 'cp-2', turn: 2 })]), 'connected');
    render(<ChangesPage projectId={acme} sessionId={claude} />);
    expect(screen.getByRole('heading', { level: 2 })).toBeTruthy();
    expect(screen.getByText(copy.chat.changes.whatItDid)).toBeTruthy();
    const turn = document.querySelector('[data-changes-turn="cp-2"]') as HTMLElement;
    fireEvent.click(within(turn).getByRole('button', { name: copy.chat.changes.show }));
    await waitFor(() => expect(turn.querySelector('[data-patch-file="notes.txt"]')).not.toBeNull());
    expect(commands).toContainEqual({ name: 'checkpoint.diff', input: { checkpointId: 'cp-2' } });
    expect(
      within(turn).getByRole('button', { name: copy.chat.changes.hide }).getAttribute('aria-expanded'),
    ).toBe('true');

    fireEvent.click(within(turn).getByRole('button', { name: copy.chat.turn.undo }));
    expect(document.activeElement).toBe(
      within(turn).getByRole('button', { name: copy.chat.turn.undoConfirm }),
    );
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(within(turn).queryByRole('button', { name: copy.chat.turn.undoConfirm })).toBeNull();
    fireEvent.click(within(turn).getByRole('button', { name: copy.chat.turn.undo }));
    fireEvent.click(within(turn).getByRole('button', { name: copy.chat.turn.undoConfirm }));
    await waitFor(() =>
      expect(commands).toContainEqual({ name: 'checkpoint.revert', input: { checkpointId: 'cp-2' } }),
    );
  });

  it('cannot undo while the agent works; an undone turn says so; the decision bar asks for changes and opens the review', () => {
    useReadModel
      .getState()
      .replaceModel(
        withCheckpoints([cp({ id: 'a' }), cp({ id: 'b', turn: 2, revertedAt: 5 })], 'working'),
        'connected',
      );
    const composer = document.createElement('div');
    composer.setAttribute('data-keyscope', 'composer');
    const box = document.createElement('textarea');
    composer.appendChild(box);
    document.body.appendChild(composer);
    render(<ChangesPage projectId={acme} sessionId={claude} />);
    expect(
      (
        within(document.querySelector('[data-changes-turn="a"]') as HTMLElement).getByRole('button', {
          name: copy.chat.turn.undo,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(document.querySelector('[data-changes-turn="b"]')?.textContent).toContain(copy.chat.turn.undone);
    const bar = within(document.querySelector('[data-changes-decide]') as HTMLElement);
    fireEvent.click(bar.getByRole('button', { name: copy.chat.changes.ask }));
    expect(document.activeElement).toBe(box);
    fireEvent.click(bar.getByRole('button', { name: copy.chat.changes.review }));
    expect(useUiStore.getState().screen).toBe('diff');
    composer.remove();
  });

  it('says when nothing changed yet, points loose changes at the review, and asks for a lane when there is none', () => {
    useReadModel.getState().replaceModel(withCheckpoints([]), 'connected');
    const { unmount } = render(<ChangesPage projectId={acme} sessionId={claude} />);
    // The demo's fix/checkout lane has changed files but no recorded turns: they are loose.
    const loose = document.querySelector('[data-changes-loose]') as HTMLElement | null;
    if (loose !== null) {
      fireEvent.click(within(loose).getByRole('button', { name: copy.chat.changes.review }));
      expect(useUiStore.getState().screen).toBe('diff');
    } else expect(screen.getByText(copy.chat.changes.emptyHeadline)).toBeTruthy();
    unmount();
    act(() => useUiStore.setState({ screen: 'workspace' }));
    render(<ChangesPage projectId={acme} sessionId={null} />);
    expect(screen.getByText(copy.chat.changes.noLane)).toBeTruthy();
  });
});

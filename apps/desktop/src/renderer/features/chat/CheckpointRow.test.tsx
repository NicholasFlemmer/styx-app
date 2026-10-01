// @vitest-environment jsdom
import {
  copy,
  fixtures,
  upsertRows,
  type Checkpoint,
  type ProjectId,
  type ReadModel,
  type SessionId,
  fill,
} from '@styx/core';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { ChatPane } from './ChatPane';
import { CheckpointRow } from './CheckpointRow';
import { transcriptItems } from './transcript-items';

const acme = fixtures.ids.project.acmeShop as ProjectId;
const claude = fixtures.ids.session.claude as SessionId;

const checkpoint = (over: Partial<Checkpoint> = {}): Checkpoint => ({
  id: 'cp-1',
  sessionId: claude,
  worktreeId: fixtures.ids.worktree.fixCheckout as Checkpoint['worktreeId'],
  turn: 1,
  messageId: null,
  baseRef: `refs/styx/checkpoints/${claude}/1/base`,
  ref: `refs/styx/checkpoints/${claude}/1/after`,
  files: 3,
  added: 40,
  removed: 8,
  createdAt: fixtures.DEMO_NOW - 60_000,
  settledAt: fixtures.DEMO_NOW - 30_000,
  revertedAt: null,
  screens: [],
  ...over,
});

/** The demo Claude transcript with a second user turn appended and checkpoints keyed to both user rows. */
const withTurns = (state: 'idle' | 'working' = 'idle', extra: Partial<Checkpoint>[] = []): ReadModel => {
  const model = fixtures.demoReadModel();
  const rows = model.transcripts[claude] ?? [];
  const firstUser = rows.find((m) => m.payload.kind === 'user');
  const base = rows[0];
  if (firstUser === undefined || base === undefined) throw new Error('fixture');
  const last = rows.reduce((n, m) => Math.max(n, m.seq), 0);
  const session = model.sessions.byId[claude];
  if (session === undefined) throw new Error('fixture');
  return {
    ...model,
    sessions: upsertRows(model.sessions, [{ ...session, state }]),
    transcripts: {
      ...model.transcripts,
      [claude]: [
        ...rows,
        {
          ...base,
          id: 'm-user-2' as typeof base.id,
          seq: last + 1,
          body: 'Now the tests.',
          askId: null,
          payload: { kind: 'user' },
        },
        {
          ...base,
          id: 'm-agent-2' as typeof base.id,
          seq: last + 2,
          body: 'Done.',
          askId: null,
          payload: { kind: 'agent' },
        },
      ],
    },
    checkpoints: {
      [claude]: [
        checkpoint({ id: 'cp-1', turn: 1, messageId: firstUser.id }),
        checkpoint({ id: 'cp-2', turn: 2, messageId: 'm-user-2', files: 1, added: 5, removed: 0 }),
        ...extra.map((e) => checkpoint(e)),
      ],
    },
  };
};

describe('CheckpointRow', () => {
  afterEach(cleanup);

  it('reads Turn n · files · counts with Review and Revert; Revert asks inline and only the confirming click reverts', () => {
    const onReview = vi.fn();
    const onRevert = vi.fn();
    render(
      <CheckpointRow
        turn={3}
        files={2}
        added={40}
        removed={8}
        reverted={false}
        busy={false}
        onReview={onReview}
        onRevert={onRevert}
      />,
    );
    const row = screen.getByText('Turn 3 · 2 files · +40 −8').closest('[data-kind="checkpoint"]');
    if (row === null) throw new Error('no row');
    expect(row.getAttribute('data-turn')).toBe('3');
    fireEvent.click(screen.getByRole('button', { name: 'Review · Turn 3' }));
    expect(onReview).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Revert this turn · Turn 3' }));
    const group = screen.getByRole('group', { name: 'Revert this turn · Turn 3' });
    expect(group.textContent).toContain(fill(copy.checkpoints.revertConfirm, { n: 3 }));
    expect(onRevert).not.toHaveBeenCalled();
    // The confirming button takes focus; Cancel returns the actions.
    const confirm = within(group).getByRole('button', { name: 'Revert this turn · Turn 3 · Yes' });
    expect(document.activeElement).toBe(confirm);
    fireEvent.click(within(group).getByRole('button', { name: copy.general.cancel }));
    expect(screen.queryByRole('group')).toBeNull();
    expect(onRevert).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Revert this turn · Turn 3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revert this turn · Turn 3 · Yes' }));
    expect(onRevert).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('Escape inside the question cancels it and does not bubble to the overlay stack', () => {
    render(
      <CheckpointRow
        turn={1}
        files={1}
        added={1}
        removed={0}
        reverted={false}
        busy={false}
        onReview={() => undefined}
        onRevert={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Revert this turn · Turn 1' }));
    const group = screen.getByRole('group');
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    fireEvent.keyDown(group, { key: 'Escape' });
    document.removeEventListener('keydown', outer);
    expect(outer).not.toHaveBeenCalled();
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('is disabled while the agent works and reads Reverted (no actions) once reverted', () => {
    const { rerender } = render(
      <CheckpointRow
        turn={1}
        files={1}
        added={1}
        removed={0}
        reverted={false}
        busy
        onReview={() => undefined}
        onRevert={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: 'Revert this turn · Turn 1' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Review · Turn 1' })).toHaveProperty('disabled', false);
    rerender(
      <CheckpointRow
        turn={1}
        files={1}
        added={1}
        removed={0}
        reverted
        busy={false}
        onReview={() => undefined}
        onRevert={() => undefined}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(copy.checkpoints.reverted)).toBeTruthy();
    expect(document.querySelector('[data-kind="checkpoint"][data-reverted="true"]')).not.toBeNull();
  });
});

describe('checkpoint rows in the transcript', () => {
  it('places a settled turn with changes after its turn, before the next user message; running / empty turns show nothing', () => {
    const model = withTurns('idle', [
      { id: 'cp-open', turn: 3, messageId: 'm-user-2', ref: null, files: 0 },
      { id: 'cp-empty', turn: 4, messageId: 'm-none', files: 0 },
    ]);
    const kinds = transcriptItems(model, claude).map((i) =>
      i.kind === 'checkpoint' ? `checkpoint:${i.turn}` : i.kind,
    );
    // Turn 1's row sits right before the second user message; turn 2's closes the transcript.
    expect(kinds.indexOf('checkpoint:1')).toBe(kinds.indexOf('user', 1) - 1);
    expect(kinds.at(-1)).toBe('checkpoint:2');
    expect(kinds.filter((k) => k.startsWith('checkpoint'))).toEqual(['checkpoint:1', 'checkpoint:2']);
    const row = transcriptItems(model, claude).find((i) => i.kind === 'checkpoint');
    expect(row).toEqual({
      id: 'checkpoint:cp-1',
      kind: 'checkpoint',
      checkpointId: 'cp-1',
      turn: 1,
      files: 3,
      added: 40,
      removed: 8,
      reverted: false,
    });
  });
});

describe('ChatPane checkpoint actions', () => {
  const commands: { name: string; input: unknown }[] = [];
  let answer: { ok: boolean; value?: unknown; error?: { code: string; message: string } } = {
    ok: true,
    value: {},
  };

  beforeEach(() => {
    commands.length = 0;
    answer = { ok: true, value: {} };
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: fixtures.DEMO_NOW },
        command: vi.fn(async (name: string, input: unknown) => {
          commands.push({ name, input });
          return name === 'checkpoint.revert' ? answer : { ok: true, value: {} };
        }),
      },
    });
    useReadModel.getState().replaceModel(withTurns(), 'connected');
    useUiStore.setState({
      overlays: [],
      screen: 'workspace',
      platform: 'darwin',
      projectId: acme,
      projectSession: {},
      diffCheckpointId: null,
    });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  /** The paper card of the turn whose checkpoint is `id` (ADR-0027 §3). */
  const card = (n: number): HTMLElement => {
    const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-kind="turn-result"]'));
    const found = cards[n];
    if (found === undefined) throw new Error(`no card ${n} of ${cards.length}`);
    return found;
  };

  it('each turn with changes ends on paper: Show changes opens the Diff on its checkpoint; a confirmed Undo reverts it', async () => {
    render(<ChatPane projectId={acme} />);
    fireEvent.click(within(card(0)).getByRole('button', { name: copy.chat.turn.showChanges }));
    expect(useUiStore.getState().diffCheckpointId).toBe('cp-1');
    expect(useUiStore.getState().screen).toBe('diff');

    expect(card(1).textContent).toContain('Done.');
    fireEvent.click(within(card(1)).getByRole('button', { name: copy.chat.turn.undo }));
    fireEvent.click(within(card(1)).getByRole('button', { name: copy.chat.turn.undoConfirm }));
    await waitFor(() =>
      expect(commands).toEqual([{ name: 'checkpoint.revert', input: { checkpointId: 'cp-2' } }]),
    );
    expect(useUiStore.getState().overlays).toEqual([]);
  });

  it('a refused undo lands as an error toast; a working session disables Undo but not Show changes', async () => {
    answer = { ok: false, error: { code: 'invalid-transition', message: 'The agent is still working.' } };
    render(<ChatPane projectId={acme} />);
    fireEvent.click(within(card(0)).getByRole('button', { name: copy.chat.turn.undo }));
    fireEvent.click(within(card(0)).getByRole('button', { name: copy.chat.turn.undoConfirm }));
    await waitFor(() => expect(useUiStore.getState().overlays).toHaveLength(1));
    expect(useUiStore.getState().overlays[0]).toMatchObject({
      kind: 'toast',
      toast: { kind: 'error', code: 'invalid-transition', message: 'The agent is still working.' },
    });

    act(() => useReadModel.getState().replaceModel(withTurns('working'), 'connected'));
    expect(within(card(0)).getByRole('button', { name: copy.chat.turn.undo })).toHaveProperty(
      'disabled',
      true,
    );
    expect(within(card(0)).getByRole('button', { name: copy.chat.turn.showChanges })).toHaveProperty(
      'disabled',
      false,
    );
  });
});

// @vitest-environment jsdom
import { fixtures, type Checkpoint, type ProjectId, type ReadModel, type SessionId } from '@styx/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { checkpointSummary, patchFiles } from './CheckpointDiff';
import { Diff } from './Diff';

const acme = fixtures.ids.project.acmeShop as ProjectId;
const claude = fixtures.ids.session.claude as SessionId;

const PATCH = [
  'diff --git a/checkout.ts b/checkout.ts',
  'index 1111111..2222222 100644',
  '--- a/checkout.ts',
  '+++ b/checkout.ts',
  '@@ -1,3 +1,3 @@',
  ' a',
  '-b',
  '+B',
  ' c',
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1 @@',
  '+hi',
  '',
].join('\n');

const withCheckpoint = (): ReadModel => {
  const model = fixtures.demoReadModel();
  const row: Checkpoint = {
    id: 'cp-1',
    sessionId: claude,
    worktreeId: fixtures.ids.worktree.fixCheckout as Checkpoint['worktreeId'],
    turn: 2,
    messageId: null,
    baseRef: 'refs/styx/checkpoints/x/2/base',
    ref: 'refs/styx/checkpoints/x/2/after',
    files: 2,
    added: 2,
    removed: 1,
    createdAt: fixtures.DEMO_NOW,
    settledAt: fixtures.DEMO_NOW,
    revertedAt: null,
  };
  return { ...model, checkpoints: { [claude]: [row] } };
};

describe('Diff screen · checkpoint mode', () => {
  const commands: { name: string; input: unknown }[] = [];
  beforeEach(() => {
    commands.length = 0;
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: fixtures.DEMO_NOW },
        command: vi.fn(async (name: string, input: unknown) => {
          commands.push({ name, input });
          if (name === 'checkpoint.diff')
            return {
              ok: true,
              value: {
                patch: PATCH,
                files: [
                  { path: 'checkout.ts', added: 1, removed: 1 },
                  { path: 'new.txt', added: 1, removed: 0 },
                ],
              },
            };
          return { ok: true, value: {} };
        }),
      },
    });
    useReadModel.getState().replaceModel(withCheckpoint(), 'connected');
    useUiStore.setState({
      overlays: [],
      screen: 'diff',
      platform: 'darwin',
      projectId: acme,
      projectSession: {},
      diffFocusIndex: 0,
      diffCheckpointId: 'cp-1',
    });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('splits a patch into one block per file with header rows; summary reads Turn n · files · counts', () => {
    const files = patchFiles(PATCH);
    expect(files.map((f) => [f.path, f.added, f.removed, f.rows.length])).toEqual([
      ['checkout.ts', 1, 1, 5],
      ['new.txt', 1, 0, 2],
    ]);
    expect(files[0]?.rows[0]).toEqual({ kind: 'header', text: '@@ -1,3 +1,3 @@' });
    expect(checkpointSummary({ turn: 2, files: 2, added: 2, removed: 1 })).toBe('Turn 2 · 2 files · +2 −1');
  });

  it('fetches the turn patch, lists its files read-only (no Revert), and Done returns to the Workspace and leaves the mode', async () => {
    render(<Diff />);
    const screenEl = document.querySelector('[data-diff-checkpoint="cp-1"]');
    expect(screenEl).not.toBeNull();
    expect(commands).toEqual([{ name: 'checkpoint.diff', input: { checkpointId: 'cp-1' } }]);
    expect(screen.getByText('Claude · fix/checkout · Turn 2 · 2 files · +2 −1')).toBeTruthy();
    const list = await screen.findByRole('list', { name: 'Review' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
    expect(within(list).getByRole('listitem', { name: 'checkout.ts' }).textContent).toContain('+ B');
    expect(within(list).getByRole('listitem', { name: 'new.txt' }).textContent).toContain('+ hi');
    expect(screen.getByText('Files · 2')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Revert/ })).toBeNull();
    // Only Done is bound: the hunk keys legend shrinks to it.
    expect(document.querySelector('[data-diff-keys]')?.textContent).toBe('⌘⏎ done');

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(useUiStore.getState().screen).toBe('workspace');
    expect(useUiStore.getState().diffCheckpointId).toBeNull();
    // Nothing was marked reviewed: the checkpoint review never touches hunks.
    expect(commands.map((c) => c.name)).toEqual(['checkpoint.diff']);
  });

  it('a failed fetch shows the error in place of the patch', async () => {
    (window as unknown as { styx: { command: unknown } }).styx.command = vi.fn(async () => ({
      ok: false,
      error: { code: 'git-error', message: 'checkpoint refs/x is gone' },
    }));
    render(<Diff />);
    expect(await screen.findByText('checkpoint refs/x is gone')).toBeTruthy();
  });
});

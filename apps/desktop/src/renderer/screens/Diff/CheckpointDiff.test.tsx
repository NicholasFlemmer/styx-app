// @vitest-environment jsdom
import { fixtures, type Checkpoint, type ProjectId, type ReadModel, type SessionId } from '@styx/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keys } from '../../keys';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { checkpointSummary, patchFiles, screenUrl } from './CheckpointDiff';
import { Diff } from './Diff';

const route = (e: KeyboardEvent) => {
  keys.dispatch(e);
};
const press = (init: KeyboardEventInit) => {
  const target = document.activeElement ?? document.body;
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
};

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

const withCheckpoint = (screens: Checkpoint['screens'] = []): ReadModel => {
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
    screens,
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
    document.removeEventListener('keydown', route, true);
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

  it('Screens: with both pictures, Before / After figures under the header, served from styx-device://, nothing focusable', async () => {
    useReadModel.getState().replaceModel(withCheckpoint(['before', 'after']), 'connected');
    document.addEventListener('keydown', route, true);
    render(<Diff />);
    const block = document.querySelector('[data-checkpoint-screens]');
    if (block === null) throw new Error('no screens block');
    const block$ = within(block as HTMLElement);
    expect(block$.getByText('Screens')).toBeTruthy();
    const imgs = block$.getAllByRole('img');
    expect(imgs.map((i) => [i.getAttribute('src'), i.getAttribute('alt')])).toEqual([
      ['styx-device://checkpoint/cp-1/before', 'Screenshot of the app before turn 2'],
      ['styx-device://checkpoint/cp-1/after', 'Screenshot of the app after turn 2'],
    ]);
    expect(screenUrl('cp-1', 'after')).toBe('styx-device://checkpoint/cp-1/after');
    // Captions read the side and the turn; the block sits between the header and the files pane.
    const captions = [...block.querySelectorAll('figcaption')].map((c) => c.textContent);
    expect(captions).toEqual(['Before turn 2', 'After turn 2']);
    expect(block$.queryByText('No screenshot: the app was not running.')).toBeNull();
    expect(block.previousElementSibling?.querySelector('[data-diff-meta]')).not.toBeNull();
    await waitFor(() =>
      expect(block.nextElementSibling?.querySelector('[data-file="checkout.ts"]') ?? null).not.toBeNull(),
    );
    // Nothing in the block takes focus, and Done's chord still lands from the screen root.
    expect([...block.querySelectorAll('[tabindex], button, a, input')]).toEqual([]);
    expect(document.activeElement).toBe(document.querySelector('[data-diff-checkpoint="cp-1"]'));
    press({ key: 'Enter', metaKey: true });
    expect(useUiStore.getState().screen).toBe('workspace');
    expect(useUiStore.getState().diffCheckpointId).toBeNull();
  });

  it('Screens: a missing side says so in its box instead of an image', () => {
    useReadModel.getState().replaceModel(withCheckpoint(['after']), 'connected');
    render(<Diff />);
    const block = document.querySelector('[data-checkpoint-screens]');
    if (block === null) throw new Error('no screens block');
    const block$ = within(block as HTMLElement);
    expect(block$.getAllByRole('img').map((i) => i.getAttribute('alt'))).toEqual([
      'Screenshot of the app after turn 2',
    ]);
    const before = block.querySelector('[data-screen-side="before"]');
    expect(before?.getAttribute('data-screen-missing')).toBe('true');
    expect(before?.textContent).toContain('No screenshot: the app was not running.');
    expect(before?.querySelector('figcaption')?.textContent).toBe('Before turn 2');
    expect(block.querySelector('[data-screen-side="after"]')?.getAttribute('data-screen-missing')).toBeNull();
  });

  it('Screens: no pictures at all, no block', () => {
    render(<Diff />);
    expect(document.querySelector('[data-checkpoint-screens]')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
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

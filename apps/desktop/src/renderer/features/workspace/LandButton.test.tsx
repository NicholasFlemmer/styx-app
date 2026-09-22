// @vitest-environment jsdom
import { copy, fixtures, upsertRows, type ProjectId, type ReadModel } from '@styx/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { plainFolderReadModel } from '../../test-support/plain-folder';
import { LandButton } from './LandButton';

const { ids } = fixtures;
const acme = ids.project.acmeShop as ProjectId;

/** The demo model with one worktree patched. */
const withWorktree = (worktreeId: string, patch: Record<string, unknown>): ReadModel => {
  const model = fixtures.demoReadModel();
  const w = model.worktrees.byId[worktreeId];
  if (w === undefined) throw new Error('fixture');
  return { ...model, worktrees: upsertRows(model.worktrees, [{ ...w, ...patch }]) };
};

describe('LandButton (discrepancy #111: landing must not live only on the Repo tab)', () => {
  beforeEach(() => {
    Object.assign(window, {
      styx: { platform: 'darwin', env: {}, command: vi.fn(async () => ({ ok: true, value: {} })) },
    });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({ overlays: [], platform: 'darwin', projectId: acme, projectSession: {} });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('lands the lane the editor column shows, through the same modal the Repo row opens', () => {
    render(<LandButton projectId={acme} />);
    const button = screen.getByRole('button', { name: copy.repo.actions.land });
    expect(button.getAttribute('title')).toBe(`${copy.repo.actions.land} · fix/checkout`);
    fireEvent.click(button);
    expect(useUiStore.getState().overlays).toMatchObject([
      { kind: 'modal', modal: 'land', worktreeId: ids.worktree.fixCheckout },
    ]);
  });

  it('follows the active chat tab, so the button lands what the workspace is showing', () => {
    useUiStore.setState({ projectSession: { [acme]: ids.session.codex } });
    render(<LandButton projectId={acme} />);
    fireEvent.click(screen.getByRole('button', { name: copy.repo.actions.land }));
    expect(useUiStore.getState().overlays).toMatchObject([
      { kind: 'modal', modal: 'land', worktreeId: ids.worktree.testFlaky },
    ]);
  });

  it('reads "Merge into main" when the project reviews its merges rather than landing them', () => {
    const model = fixtures.demoReadModel();
    useReadModel.getState().replaceModel(
      {
        ...model,
        settings: {
          ...model.settings,
          project: {
            ...model.settings.project,
            [acme]: {
              ...model.settings.project[acme],
              integration: { value: 'review', source: 'project' },
            },
          },
        },
      } as ReadModel,
      'connected',
    );
    render(<LandButton projectId={acme} />);
    expect(screen.getByRole('button', { name: 'Merge into main' })).toBeTruthy();
  });

  it.each([
    ['main itself', ids.worktree.acmeMain, {}],
    ['a conflicted lane', ids.worktree.fixCheckout, { conflict: { file: 'a.ts', against: 'main' } }],
    ['a lane already merged', ids.worktree.fixCheckout, { mergedAt: fixtures.DEMO_NOW }],
    [
      'a lane an agent is mid-merge on',
      ids.worktree.fixCheckout,
      { resolution: { state: 'resolving', sessionId: null, files: [], mergeCommit: null, reason: null } },
    ],
  ])('offers nothing for %s', (_name, worktreeId, patch) => {
    if (worktreeId === ids.worktree.acmeMain) {
      // Main is what the project shows when no session owns a lane.
      useReadModel.getState().replaceModel(
        {
          ...fixtures.demoReadModel(),
          sessions: { byId: {}, ids: [] },
        } as ReadModel,
        'connected',
      );
    } else {
      useReadModel.getState().replaceModel(withWorktree(worktreeId, patch), 'connected');
    }
    render(<LandButton projectId={acme} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a plain folder has no branch to land (side-api is the one with no git)', () => {
    useReadModel.getState().replaceModel(plainFolderReadModel(), 'connected');
    render(<LandButton projectId={ids.project.sideApi as ProjectId} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

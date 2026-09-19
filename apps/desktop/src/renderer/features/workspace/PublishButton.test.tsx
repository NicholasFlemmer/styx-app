// @vitest-environment jsdom
import { fixtures, type ProjectId } from '@styx/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { plainFolderReadModel } from '../../test-support/plain-folder';
import { PublishButton } from './PublishButton';

const { ids } = fixtures;

describe('PublishButton', () => {
  beforeEach(() => {
    Object.assign(window, {
      styx: { platform: 'darwin', env: {}, command: vi.fn(async () => ({ ok: true, value: {} })) },
    });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({ overlays: [], platform: 'darwin', projectId: ids.project.acmeShop });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('opens the publish modal for the worktree the editor shows (the first session tab: fix/checkout)', () => {
    render(<PublishButton projectId={ids.project.acmeShop as ProjectId} />);
    const button = screen.getByRole('button', { name: 'Publish' });
    expect(button.getAttribute('title')).toBe('Publish · fix/checkout');
    fireEvent.click(button);
    expect(useUiStore.getState().overlays).toMatchObject([
      { kind: 'modal', modal: 'publish', worktreeId: ids.worktree.fixCheckout },
    ]);
  });

  it('a project without sessions publishes main; a plain folder gets no button', () => {
    render(<PublishButton projectId={ids.project.blogV2 as ProjectId} />);
    // blog-v2's only session sits on feat/mdx.
    expect(screen.getByRole('button', { name: 'Publish' }).getAttribute('title')).toBe('Publish · feat/mdx');
    cleanup();
    useReadModel.getState().replaceModel(plainFolderReadModel(), 'connected');
    render(<PublishButton projectId={ids.project.sideApi as ProjectId} />);
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
  });
});

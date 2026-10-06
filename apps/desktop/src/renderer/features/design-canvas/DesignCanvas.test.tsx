// @vitest-environment jsdom
import { copy, fixtures, type DesignList } from '@styx/core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { DesignCanvas } from './DesignCanvas';

const { ids } = fixtures;
const acme = ids.project.acmeShop;
/** The demo's Claude lane: a build task with no linked design. */
const build = ids.session.claude;

const listWith = (screens: DesignList['screens']) => (worktreeId: string) =>
  ({ worktreeId, screens, tokens: null }) satisfies DesignList;

const DOCS: DesignList['screens'] = [
  {
    slug: 'docs',
    name: 'Docs',
    files: [{ path: 'docs/desktop.html', screen: 'docs', size: 'desktop', fidelity: 'hi', mtime: 1 }],
  },
];

const mount = (list: (worktreeId: string) => DesignList) => {
  Object.assign(window, {
    styx: {
      platform: 'darwin',
      env: { now: fixtures.DEMO_NOW },
      command: vi.fn(async (name: string, input: { worktreeId?: string }) => {
        if (name === 'design.list') return { ok: true, value: list(input.worktreeId ?? '') };
        if (name === 'design.read') return { ok: true, value: { html: '<p>docs</p>', css: '' } };
        return { ok: true, value: {} };
      }),
    },
  });
  render(<DesignCanvas projectId={acme} sessionId={build} />);
};

describe('DesignCanvas: a build task with its own screens (#150)', () => {
  beforeEach(() => {
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({ overlays: [], platform: 'darwin' });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('shows the screens in its own worktree, without Build it (it is the build)', async () => {
    mount(listWith(DOCS));
    const nav = await screen.findByRole('navigation', { name: copy.chat.design.screens });
    await waitFor(() => expect(nav.textContent).toContain('Docs'));
    expect(document.querySelector('[data-design-build]')).toBeNull();
    expect(document.querySelector('[data-design-start]')).toBeNull();
  });

  it('with no screens of its own, offers to start a design as before', async () => {
    mount(listWith([]));
    await waitFor(() => expect(document.querySelector('[data-design-start]')).not.toBeNull());
    expect(screen.queryByRole('navigation', { name: copy.chat.design.screens })).toBeNull();
  });
});

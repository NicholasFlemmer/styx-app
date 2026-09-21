// @vitest-environment jsdom
import { copy, fixtures, type WorktreeId } from '@styx/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { ConnectRepoModal, repoNameOf } from './ConnectRepoModal';

const { ids } = fixtures;
const acme = ids.project.acmeShop;
const commandMock = vi.fn(async () => ({ ok: true as const, value: { url: 'x', htmlUrl: null } }));
const calls = (name: string) =>
  commandMock.mock.calls.filter((c) => (c as unknown[])[0] === name).map((c) => (c as unknown[])[1]);

/** The demo model with (or without) a connected GitHub target. */
const seed = (github: boolean, remote: string | null = null) => {
  const model = fixtures.demoReadModel();
  const byId = Object.fromEntries(
    Object.entries(model.targets.byId).map(([id, t]) => [
      id,
      t.provider === 'github' ? { ...t, credentialRef: github ? 'cred:gh' : null } : t,
    ]),
  );
  const repo = model.repos.byId[ids.repo.acmeShop];
  if (!repo) throw new Error('fixture repo');
  useReadModel.getState().replaceModel(
    {
      ...model,
      targets: { ...model.targets, byId },
      repos: {
        ...model.repos,
        byId: {
          ...model.repos.byId,
          [repo.id]: { ...repo, remotes: remote === null ? [] : [{ name: 'origin', url: remote }] },
        },
      },
    },
    'connected',
  );
};

describe('ConnectRepoModal', () => {
  beforeEach(() => {
    commandMock.mockReset();
    commandMock.mockImplementation(async () => ({ ok: true as const, value: { url: 'x', htmlUrl: null } }));
    Object.assign(window, { styx: { platform: 'darwin', env: {}, command: commandMock } });
    seed(true);
    useUiStore.setState({
      overlays: [{ id: 'modal-1', kind: 'modal', modal: 'connect-repo', projectId: acme }],
      platform: 'darwin',
      projectId: acme,
    });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('with GitHub connected it defaults to creating a private repo named after the project, and connects', async () => {
    render(<ConnectRepoModal id="modal-1" projectId={acme} />);
    expect(screen.getByRole('dialog', { name: 'Connect acme-shop to GitHub' })).toBeTruthy();
    const name = screen.getByLabelText(copy.connectRepo.name) as HTMLInputElement;
    expect(name.value).toBe('acme-shop');
    fireEvent.change(name, { target: { value: 'shop-web' } });
    fireEvent.click(screen.getByLabelText(copy.connectRepo.private));
    fireEvent.click(screen.getByRole('button', { name: copy.connectRepo.cta }));
    await waitFor(() => expect(useUiStore.getState().overlays).toHaveLength(0));
    expect(calls('project.connectRemote')).toEqual([
      { projectId: acme, remote: { kind: 'create', name: 'shop-web', isPrivate: false }, replace: false },
    ]);
    expect(repoNameOf('Good Shout (web)!')).toBe('Good-Shout-web');
  });

  it('without GitHub it starts on an existing URL, says why creating is off, and reopens Publish when asked to', async () => {
    seed(false);
    const returnTo = { modal: 'publish' as const, worktreeId: ids.worktree.fixCheckout as WorktreeId };
    render(<ConnectRepoModal id="modal-1" projectId={acme} returnTo={returnTo} />);
    const url = screen.getByLabelText(copy.connectRepo.url) as HTMLInputElement;
    expect(url.value).toBe('');
    expect((screen.getByRole('button', { name: copy.connectRepo.cta }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // Creating is on offer but explained, and cannot be sent without a GitHub connection.
    fireEvent.click(screen.getByRole('radio', { name: copy.connectRepo.kinds.create }));
    expect(screen.getByText(copy.connectRepo.noGithub)).toBeTruthy();
    expect((screen.getByRole('button', { name: copy.connectRepo.cta }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('radio', { name: copy.connectRepo.kinds.existing }));
    fireEvent.change(screen.getByLabelText(copy.connectRepo.url), { target: { value: ' acme/shop ' } });
    fireEvent.click(screen.getByRole('button', { name: copy.connectRepo.cta }));
    await waitFor(() =>
      expect(useUiStore.getState().overlays).toEqual([
        expect.objectContaining({ kind: 'modal', modal: 'publish', worktreeId: returnTo.worktreeId }),
      ]),
    );
    expect(calls('project.connectRemote')).toEqual([
      { projectId: acme, remote: { kind: 'existing', url: 'acme/shop' }, replace: false },
    ]);
  });

  it('with a remote already there it reconnects: the current one is named, and the call replaces it', async () => {
    seed(false, 'https://github.com/acme/old.git');
    render(<ConnectRepoModal id="modal-1" projectId={acme} />);
    expect(
      screen.getByText('Connected to https://github.com/acme/old.git. Connecting again replaces it.'),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText(copy.connectRepo.url), { target: { value: 'acme/new' } });
    fireEvent.click(screen.getByRole('button', { name: copy.connectRepo.reconnectCta }));
    await waitFor(() => expect(useUiStore.getState().overlays).toHaveLength(0));
    expect(calls('project.connectRemote')).toEqual([
      { projectId: acme, remote: { kind: 'existing', url: 'acme/new' }, replace: true },
    ]);
  });

  it('a refusal keeps the modal open with the reason', async () => {
    commandMock.mockImplementation(
      async () =>
        ({
          ok: false,
          error: { code: 'invalid-input', message: 'This project already has a remote: x.' },
        }) as never,
    );
    render(<ConnectRepoModal id="modal-1" projectId={acme} />);
    fireEvent.click(screen.getByRole('button', { name: copy.connectRepo.cta }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('This project already has a remote: x.'),
    );
    // The command helper also raises its error toast; the modal itself stays.
    expect(useUiStore.getState().overlays.filter((o) => o.kind === 'modal')).toHaveLength(1);
  });
});

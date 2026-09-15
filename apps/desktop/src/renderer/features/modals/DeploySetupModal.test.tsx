// @vitest-environment jsdom
import { copy, fixtures } from '@styx/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { DeploySetupModal } from './DeploySetupModal';

const { ids } = fixtures;
const commandMock = vi.fn(async () => ({ ok: true as const, value: {} }));
const calls = (name: string) => commandMock.mock.calls.filter((c) => (c as unknown[])[0] === name);

describe('DeploySetupModal', () => {
  beforeEach(() => {
    commandMock.mockClear();
    Object.assign(window, { styx: { platform: 'darwin', env: {}, command: commandMock } });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({
      overlays: [{ id: 'modal-1', kind: 'modal', modal: 'deploy-setup', projectId: ids.project.acmeShop }],
      platform: 'darwin',
      projectId: ids.project.acmeShop,
    });
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('lists every project target: Vercel rows are built in, the rest take a command with a provider placeholder', () => {
    render(<DeploySetupModal id="modal-1" projectId={ids.project.acmeShop} />);
    expect(screen.getByRole('dialog', { name: 'Deploy · acme-shop' })).toBeTruthy();
    const rows = document.querySelectorAll('[data-deploy-target]');
    expect(rows.length).toBe(5);
    const vercel = document.querySelector(`[data-deploy-target="${ids.target.vercelProd}"]`) as HTMLElement;
    expect(vercel.textContent).toContain('built in · vercel deploy --prod');
    expect(within(vercel).queryByLabelText(copy.deploy.commandLabel)).toBeNull();
    const aws = document.querySelector(`[data-deploy-target="${ids.target.awsProd}"]`) as HTMLElement;
    const field = within(aws).getByLabelText(copy.deploy.commandLabel) as HTMLInputElement;
    expect(field.value).toBe('');
    expect(field.placeholder).toBe(copy.deploy.placeholders.aws);
    expect((screen.getByRole('button', { name: copy.deploy.save }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Save sends target.setDeployCommand for each changed row (empty → null) and closes', async () => {
    render(<DeploySetupModal id="modal-1" projectId={ids.project.acmeShop} />);
    const aws = document.querySelector(`[data-deploy-target="${ids.target.awsProd}"]`) as HTMLElement;
    fireEvent.change(within(aws).getByLabelText(copy.deploy.commandLabel), {
      target: { value: '  sam deploy --stack-name acme  ' },
    });
    const supabase = document.querySelector(
      `[data-deploy-target="${ids.target.supabaseProd}"]`,
    ) as HTMLElement;
    fireEvent.change(within(supabase).getByLabelText(copy.deploy.commandLabel), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: copy.deploy.save }));
    await waitFor(() => expect(useUiStore.getState().overlays).toHaveLength(0));
    expect(calls('target.setDeployCommand').map((c) => (c as unknown[])[1])).toEqual([
      { targetId: ids.target.awsProd, command: 'sam deploy --stack-name acme' },
    ]);
  });

  it('a failed save keeps the modal open and shows the error', async () => {
    commandMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'not-found', message: 'target not found' },
    } as never);
    render(<DeploySetupModal id="modal-1" projectId={ids.project.acmeShop} />);
    const aws = document.querySelector(`[data-deploy-target="${ids.target.awsProd}"]`) as HTMLElement;
    fireEvent.change(within(aws).getByLabelText(copy.deploy.commandLabel), {
      target: { value: 'sam deploy' },
    });
    fireEvent.click(screen.getByRole('button', { name: copy.deploy.save }));
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toBe('target not found'));
    // The command helper also raises its error toast; the modal itself stays.
    expect(useUiStore.getState().overlays.filter((o) => o.kind === 'modal')).toHaveLength(1);
  });
});

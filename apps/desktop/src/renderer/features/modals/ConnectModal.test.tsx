// @vitest-environment jsdom
import { copy, fixtures } from '@styx/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { ConnectModal } from './ConnectModal';

const acme = fixtures.ids.project.acmeShop;
let browserUrl: string | null = 'https://vercel.com/oauth';

const commandMock = vi.fn(async (name: string) => {
  switch (name) {
    case 'target.connect.start':
      return { ok: true as const, value: { flowId: 'flow-1', authMethod: 'oauth', browserUrl } };
    case 'target.connect.saveKey':
    case 'target.connect.saveSsh':
    case 'target.connect.saveToken':
      return { ok: true as const, value: { targetId: 'target-new' } };
    case 'target.test':
      return { ok: true as const, value: { ok: true, message: null } };
    default:
      return { ok: true as const, value: {} };
  }
});

const openModal = () => {
  useUiStore.setState({ overlays: [{ id: 'modal-1', kind: 'modal', modal: 'connect', projectId: acme }] });
};

describe('ConnectModal', () => {
  beforeEach(() => {
    commandMock.mockClear();
    browserUrl = 'https://vercel.com/oauth';
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: fixtures.DEMO_NOW },
        command: commandMock,
        onEvent: () => () => {},
      },
    });
    useReadModel.getState().replaceModel(fixtures.demoReadModel(), 'connected');
    useUiStore.setState({ overlays: [], screen: 'workspace', platform: 'darwin', projectId: acme });
    openModal();
  });
  afterEach(() => {
    cleanup();
    Object.assign(window, { styx: undefined });
  });

  it('opens on the provider grid with method labels and no footer', () => {
    render(<ConnectModal id="modal-1" projectId={acme} />);
    expect(screen.getByRole('dialog').textContent).toContain('Connect target · choose provider');
    const tiles = screen.getByRole('group', { name: copy.connect.stepPick }).querySelectorAll('button');
    expect([...tiles].map((t) => t.textContent)).toEqual([
      'VercelOAuth',
      'AWSIAM / key',
      'GCPIAM / key',
      'SupabaseOAuth',
      'GitHubOAuth',
      'SSH hostSSH',
    ]);
    expect(screen.queryByRole('button', { name: copy.connect.back })).toBeNull();
  });

  it('key step: Save stays disabled until all fields are filled, then saves, tests and closes', async () => {
    render(<ConnectModal id="modal-1" projectId={acme} />);
    fireEvent.click(screen.getByRole('button', { name: /^AWS/ }));
    expect(screen.getByRole('dialog').textContent).toContain('Connect target · IAM / key');
    const save = screen.getByRole('button', { name: 'Save to Keychain' });
    const test = screen.getByRole('button', { name: copy.connect.key.test });
    expect(save.hasAttribute('disabled')).toBe(true);
    expect(test.hasAttribute('disabled')).toBe(true);

    fireEvent.change(screen.getByLabelText(copy.connect.key.name), { target: { value: 'acme-prod' } });
    fireEvent.change(screen.getByLabelText(copy.connect.key.accessKey), { target: { value: 'AKIA123' } });
    expect(save.hasAttribute('disabled')).toBe(true);
    const secret = screen.getByLabelText(copy.connect.key.secret);
    expect(secret.getAttribute('type')).toBe('password');
    fireEvent.change(secret, { target: { value: 'shh' } });
    expect(save.hasAttribute('disabled')).toBe(false);

    fireEvent.click(screen.getByRole('radio', { name: 'staging' }));
    fireEvent.click(save);
    await waitFor(() => expect(useUiStore.getState().overlays).toHaveLength(0));
    expect(commandMock).toHaveBeenCalledWith('target.connect.saveKey', {
      projectId: acme,
      provider: 'aws',
      name: 'acme-prod',
      env: 'staging',
      accessKey: 'AKIA123',
      secret: 'shh',
      config: {},
    });
    expect(commandMock).toHaveBeenCalledWith('target.test', { targetId: 'target-new' });
  });

  it('key step: Test connection saves once and shows the result without closing', async () => {
    render(<ConnectModal id="modal-1" projectId={acme} provider="gcp" />);
    fireEvent.change(screen.getByLabelText(copy.connect.key.name), { target: { value: 'gcp-infra' } });
    fireEvent.change(screen.getByLabelText(copy.connect.key.accessKey), { target: { value: 'sa@acme' } });
    fireEvent.change(screen.getByLabelText(copy.connect.key.secret), { target: { value: 'json' } });
    fireEvent.click(screen.getByRole('button', { name: copy.connect.key.test }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(copy.audit.actions.connected));
    fireEvent.click(screen.getByRole('button', { name: copy.connect.key.test }));
    await waitFor(() => expect(commandMock.mock.calls.filter((c) => c[0] === 'target.test')).toHaveLength(2));
    expect(commandMock.mock.calls.filter((c) => c[0] === 'target.connect.saveKey')).toHaveLength(1);
    expect(useUiStore.getState().overlays).toHaveLength(1);
  });

  it('ssh step: Browse is disabled; Save sends target.connect.saveSsh named after the host', async () => {
    render(<ConnectModal id="modal-1" projectId={acme} provider="ssh" />);
    expect(screen.getByRole('dialog').textContent).toContain('Connect target · SSH');
    expect(screen.getByRole('button', { name: copy.connect.ssh.browse }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(copy.connect.ssh.body)).toBeTruthy();
    const save = screen.getByRole('button', { name: copy.connect.ssh.save });
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText(copy.connect.ssh.host), {
      target: { value: 'prod-1.acme.internal' },
    });
    fireEvent.change(screen.getByLabelText(copy.connect.ssh.user), { target: { value: 'deploy' } });
    fireEvent.change(screen.getByLabelText(copy.connect.ssh.key), { target: { value: '~/.ssh/id_ed25519' } });
    fireEvent.click(save);
    await waitFor(() => expect(useUiStore.getState().overlays).toHaveLength(0));
    expect(commandMock).toHaveBeenCalledWith('target.connect.saveSsh', {
      projectId: acme,
      name: 'prod-1.acme.internal',
      env: 'prod',
      host: 'prod-1.acme.internal',
      user: 'deploy',
      keyPath: '~/.ssh/id_ed25519',
    });
  });

  it('oauth step: Open browser starts the flow; Back returns to the grid', async () => {
    render(<ConnectModal id="modal-1" projectId={acme} />);
    fireEvent.click(screen.getByRole('button', { name: /^Vercel/ }));
    expect(screen.getByRole('dialog').textContent).toContain('Connect target · OAuth');
    expect(screen.getByText(copy.connect.oauth.waiting)).toBeTruthy();
    expect(screen.getByText(/macOS Keychain/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: copy.connect.oauth.open }));
    await waitFor(() =>
      expect(commandMock).toHaveBeenCalledWith('target.connect.start', {
        projectId: acme,
        provider: 'vercel',
        env: 'prod',
      }),
    );
    expect(screen.getByText(copy.connect.oauth.waiting)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: copy.connect.back }));
    expect(screen.getByRole('dialog').textContent).toContain('Connect target · choose provider');
  });

  it('oauth step: a null browserUrl switches to a masked token field saved via target.connect.saveToken', async () => {
    browserUrl = null;
    render(<ConnectModal id="modal-1" projectId={acme} provider="github" />);
    fireEvent.click(screen.getByRole('button', { name: copy.connect.oauth.open }));
    const token = await screen.findByLabelText(copy.connect.key.secret);
    expect(token.getAttribute('type')).toBe('password');
    const save = screen.getByRole('button', { name: 'Save to Keychain' });
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.change(token, { target: { value: 'ghp_abc' } });
    fireEvent.click(save);
    await waitFor(() => expect(useUiStore.getState().overlays).toHaveLength(0));
    expect(commandMock).toHaveBeenCalledWith('target.connect.saveToken', {
      targetId: 'flow-1',
      token: 'ghp_abc',
    });
  });

  it('uses Credential Manager wording on Windows', () => {
    useUiStore.setState({ platform: 'win32' });
    render(<ConnectModal id="modal-1" projectId={acme} provider="aws" />);
    expect(screen.getByRole('button', { name: 'Save to Credential Manager' })).toBeTruthy();
    expect(screen.getByText(/Windows Credential Manager/)).toBeTruthy();
  });
});

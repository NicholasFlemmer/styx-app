// @vitest-environment jsdom
import { copy, fixtures, type CommandOutput, type ReadModel } from '@styx/core';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import { ConnectModal } from './ConnectModal';

// xterm needs a real layout engine; the modal only needs the entry to be created, attached and disposed.
vi.mock('./login-terminal', () => ({
  createLoginTerminal: vi.fn((terminalId: string) => ({ terminalId, term: { focus: vi.fn() } })),
  disposeLoginTerminal: vi.fn(),
}));
vi.mock('../terminal/terminal-registry', () => ({
  attachTerminal: vi.fn(),
  detachTerminal: vi.fn(),
  isReservedKey: () => false,
}));
const loginTerminal = await import('./login-terminal');

const acme = fixtures.ids.project.acmeShop;
let browserUrl: string | null = 'https://vercel.com/oauth';

type CliStatus = CommandOutput<'target.connect.cliStatus'>;
const gcloudStatus = (): CliStatus => ({
  installed: true,
  binary: 'gcloud',
  version: '512.0.0',
  loginCommand: 'gcloud auth login',
  accounts: [
    { id: 'nic@acme.dev', label: 'nic@acme.dev', active: false, detail: 'acme-shop' },
    { id: 'ops@acme.dev', label: 'ops@acme.dev', active: true },
  ],
});
let cliStatus: CliStatus = gcloudStatus();

const listeners = new Map<string, Set<(payload: unknown) => void>>();
const emit = (name: string, payload: unknown) => {
  act(() => {
    for (const cb of listeners.get(name) ?? []) cb(payload);
  });
};

const commandMock = vi.fn(async (name: string, _input?: unknown) => {
  switch (name) {
    case 'target.connect.start':
      return { ok: true as const, value: { flowId: 'flow-1', authMethod: 'oauth', browserUrl } };
    case 'target.connect.saveKey':
    case 'target.connect.saveSsh':
    case 'target.connect.saveToken':
      return { ok: true as const, value: { targetId: 'target-new' } };
    case 'target.connect.cliStatus':
      return { ok: true as const, value: cliStatus };
    case 'target.connect.cliLogin':
      return { ok: true as const, value: { terminalId: 'pty-login-1' } };
    case 'target.connect.cliSave':
      return { ok: true as const, value: { targetId: 'target-cli' } };
    case 'target.test':
      return { ok: true as const, value: { ok: true, message: null } };
    case 'dialog.pickFile':
      return { ok: true as const, value: { path: '/Users/me/.ssh/deploy_key' } };
    default:
      return { ok: true as const, value: {} };
  }
});

const calls = (name: string) => commandMock.mock.calls.filter((c) => c[0] === name);

const openModal = () => {
  useUiStore.setState({ overlays: [{ id: 'modal-1', kind: 'modal', modal: 'connect', projectId: acme }] });
};

/** Demo model with AWS acme-prod turned into a CLI-backed target (`aws` profile `acme-prod`). */
const withCliTarget = (): ReadModel => {
  const m = fixtures.demoReadModel();
  const aws = m.targets.byId[fixtures.ids.target.awsProd];
  if (aws === undefined) throw new Error('no aws target');
  return {
    ...m,
    targets: {
      ...m.targets,
      byId: { ...m.targets.byId, [aws.id]: { ...aws, authMethod: 'cli', config: { account: 'acme-prod' } } },
    },
  };
};

const expandAdvanced = () => fireEvent.click(screen.getByRole('button', { name: /^Advanced/ }));

describe('ConnectModal', () => {
  beforeEach(() => {
    commandMock.mockClear();
    vi.mocked(loginTerminal.createLoginTerminal).mockClear();
    vi.mocked(loginTerminal.disposeLoginTerminal).mockClear();
    listeners.clear();
    browserUrl = 'https://vercel.com/oauth';
    cliStatus = gcloudStatus();
    Object.assign(window, {
      styx: {
        platform: 'darwin',
        env: { now: fixtures.DEMO_NOW },
        command: commandMock,
        onEvent: (name: string, cb: (payload: unknown) => void) => {
          const set = listeners.get(name) ?? new Set();
          set.add(cb);
          listeners.set(name, set);
          return () => set.delete(cb);
        },
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
    expect(calls('target.connect.cliStatus')).toHaveLength(0);
  });

  describe('cli step (primary path)', () => {
    it('picking a provider opens "Connect with gcloud": status, accounts with the active one chosen, Connect → cliSave', async () => {
      render(<ConnectModal id="modal-1" projectId={acme} />);
      fireEvent.click(screen.getByRole('button', { name: /^GCP/ }));
      const dialog = screen.getByRole('dialog');
      expect(dialog.textContent).toContain('Connect target · gcloud CLI');
      expect(screen.getByText('Connect with gcloud')).toBeTruthy();
      expect(screen.getByText(fill(copy.connect.cli.body, 'gcloud'))).toBeTruthy();
      await waitFor(() => expect(screen.getByText('gcloud 512.0.0')).toBeTruthy());
      expect(commandMock).toHaveBeenCalledWith('target.connect.cliStatus', { provider: 'gcp' });

      const group = screen.getByRole('radiogroup', { name: copy.connect.cli.account });
      const rows = within(group).getAllByRole('radio');
      expect(rows.map((r) => r.textContent)).toEqual(['nic@acme.devacme-shop', 'ops@acme.devactive']);
      expect(rows[1]?.getAttribute('aria-checked')).toBe('true');
      expect(rows[1]?.getAttribute('data-inv')).toBe('true');
      expect(rows[0]?.getAttribute('data-inv')).toBeNull();

      const connect = screen.getByRole('button', { name: copy.connect.cli.connect });
      expect(connect.hasAttribute('disabled')).toBe(false);
      fireEvent.click(rows[0] as HTMLElement);
      expect(rows[0]?.getAttribute('aria-checked')).toBe('true');
      fireEvent.click(screen.getByRole('radio', { name: 'staging' }));
      fireEvent.click(connect);
      await waitFor(() => expect(useUiStore.getState().overlays).toHaveLength(0));
      expect(commandMock).toHaveBeenCalledWith('target.connect.cliSave', {
        projectId: acme,
        provider: 'gcp',
        env: 'staging',
        name: 'GCP nic@acme.dev',
        account: 'nic@acme.dev',
        config: {},
      });
      expect(calls('target.connect.cliLogin')).toHaveLength(0);
    });

    it('a typed name wins over the derived one', async () => {
      render(<ConnectModal id="modal-1" projectId={acme} provider="gcp" />);
      await waitFor(() => expect(screen.getByText('gcloud 512.0.0')).toBeTruthy());
      fireEvent.change(screen.getByLabelText(copy.connect.cli.name), { target: { value: ' gcp-infra ' } });
      fireEvent.click(screen.getByRole('button', { name: copy.connect.cli.connect }));
      await waitFor(() => expect(calls('target.connect.cliSave')).toHaveLength(1));
      expect(calls('target.connect.cliSave')[0]?.[1]).toMatchObject({
        name: 'gcp-infra',
        account: 'ops@acme.dev',
      });
    });

    it('a missing binary reads "not found on PATH · Install guide" and disables Connect and Sign in', async () => {
      cliStatus = {
        installed: false,
        binary: null,
        version: null,
        loginCommand: 'gh auth login',
        accounts: [],
      };
      render(<ConnectModal id="modal-1" projectId={acme} provider="github" />);
      await waitFor(() => expect(screen.getByText('gh · not found on PATH')).toBeTruthy());
      expect(
        screen.getByRole('button', { name: copy.connect.cli.installGuide }).hasAttribute('disabled'),
      ).toBe(true);
      expect(
        screen.getByText('gh is not installed. Install it, or use Advanced to paste a key.'),
      ).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Sign in with gh…' }).hasAttribute('disabled')).toBe(true);
      expect(screen.getByRole('button', { name: copy.connect.cli.connect }).hasAttribute('disabled')).toBe(
        true,
      );
      expect(screen.queryByRole('radiogroup', { name: copy.connect.cli.account })).toBeNull();
    });

    it('login path: no account → Sign in runs cliLogin, shows the terminal, exit re-runs cliStatus and refreshes accounts', async () => {
      cliStatus = { ...gcloudStatus(), accounts: [] };
      render(<ConnectModal id="modal-1" projectId={acme} provider="gcp" />);
      await waitFor(() =>
        expect(screen.getByText('No account signed in. Run gcloud auth login to sign in.')).toBeTruthy(),
      );
      expect(screen.getByRole('button', { name: copy.connect.cli.connect }).hasAttribute('disabled')).toBe(
        true,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Sign in with gcloud…' }));
      await waitFor(() =>
        expect(commandMock).toHaveBeenCalledWith('target.connect.cliLogin', {
          projectId: acme,
          provider: 'gcp',
        }),
      );
      const terminal = await waitFor(() => {
        const el = document.querySelector('[data-login-terminal="pty-login-1"]');
        if (el === null) throw new Error('no terminal');
        return el;
      });
      expect(terminal.textContent).toContain('Waiting for gcloud auth login…');
      expect(loginTerminal.createLoginTerminal).toHaveBeenCalledWith('pty-login-1', { screenReader: false });
      expect(screen.getByRole('button', { name: 'Sign in with gcloud…' }).hasAttribute('disabled')).toBe(
        true,
      );

      emit('connect.cliLogin', { terminalId: 'other', provider: 'gcp', status: 'exited', exitCode: 0 });
      expect(calls('target.connect.cliStatus')).toHaveLength(1);

      cliStatus = gcloudStatus();
      emit('connect.cliLogin', { terminalId: 'pty-login-1', provider: 'gcp', status: 'exited', exitCode: 0 });
      await waitFor(() => expect(calls('target.connect.cliStatus')).toHaveLength(2));
      await waitFor(() => expect(screen.getAllByRole('radio', { name: /acme\.dev/ })).toHaveLength(2));
      expect(document.querySelector('[data-login-terminal]')).toBeNull();
      expect(loginTerminal.disposeLoginTerminal).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: copy.connect.cli.connect }).hasAttribute('disabled')).toBe(
        false,
      );
    });

    it('a failed login keeps the terminal and reports the exit code', async () => {
      cliStatus = { ...gcloudStatus(), accounts: [] };
      render(<ConnectModal id="modal-1" projectId={acme} provider="gcp" />);
      await waitFor(() => expect(screen.getByText('gcloud 512.0.0')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Sign in with gcloud…' }));
      await waitFor(() => expect(document.querySelector('[data-login-terminal]')).not.toBeNull());
      emit('connect.cliLogin', { terminalId: 'pty-login-1', provider: 'gcp', status: 'exited', exitCode: 1 });
      await waitFor(() =>
        expect(screen.getByRole('status').textContent).toBe('gcloud auth login exited with code 1.'),
      );
      expect(document.querySelector('[data-login-terminal]')?.textContent).toContain('exited with code 1');
      expect(calls('target.connect.cliStatus')).toHaveLength(2);
    });

    it('reconnecting a cli target starts its login on open with the target account, name and env prefilled', async () => {
      useReadModel.getState().replaceModel(withCliTarget(), 'connected');
      cliStatus = {
        installed: true,
        binary: 'aws',
        version: '2.17.0',
        loginCommand: 'aws sso login',
        accounts: [{ id: 'acme-prod', label: 'acme-prod', active: true }],
      };
      render(
        <ConnectModal id="modal-1" projectId={acme} provider="aws" targetId={fixtures.ids.target.awsProd} />,
      );
      await waitFor(() =>
        expect(commandMock).toHaveBeenCalledWith('target.connect.cliLogin', {
          projectId: acme,
          provider: 'aws',
          account: 'acme-prod',
        }),
      );
      await waitFor(() =>
        expect(document.querySelector('[data-login-terminal="pty-login-1"]')).not.toBeNull(),
      );
      expect(screen.getByRole('dialog').textContent).toContain('Waiting for aws sso login…');
      expect((screen.getByLabelText(copy.connect.cli.name) as HTMLInputElement).value).toBe('AWS acme-prod');
      expect(screen.getByRole('radio', { name: 'prod' }).getAttribute('aria-checked')).toBe('true');
      expect(screen.getByRole('button', { name: /^Advanced/ }).getAttribute('aria-expanded')).toBe('false');
    });

    it('Advanced ▾ reveals the key form for AWS and the OAuth form for Vercel; Back returns to the grid', async () => {
      render(<ConnectModal id="modal-1" projectId={acme} />);
      fireEvent.click(screen.getByRole('button', { name: /^AWS/ }));
      await waitFor(() => expect(calls('target.connect.cliStatus')).toHaveLength(1));
      expect(screen.queryByLabelText(copy.connect.key.accessKey)).toBeNull();
      const disclosure = screen.getByRole('button', { name: /^Advanced/ });
      expect(disclosure.getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(disclosure);
      expect(disclosure.getAttribute('aria-expanded')).toBe('true');
      expect(screen.getByRole('dialog').textContent).toContain('Connect target · IAM / key');
      expect(screen.getByLabelText(copy.connect.key.accessKey)).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Save to Keychain' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: copy.connect.cli.connect })).toBeNull();
      // The CLI step's optional Name yields to the key form's own Name field while Advanced is open.
      expect(screen.getAllByLabelText(copy.connect.key.name)).toHaveLength(1);

      fireEvent.click(screen.getByRole('button', { name: copy.connect.back }));
      expect(screen.getByRole('dialog').textContent).toContain('Connect target · choose provider');
      fireEvent.click(screen.getByRole('button', { name: /^Vercel/ }));
      expandAdvanced();
      expect(screen.getByRole('dialog').textContent).toContain('Connect target · OAuth');
      expect(screen.getByText(copy.connect.oauth.waiting)).toBeTruthy();
      expect(screen.getByRole('button', { name: copy.connect.oauth.open })).toBeTruthy();
    });
  });

  it('key step (Advanced): Save stays disabled until all fields are filled, then saves, tests and closes', async () => {
    render(<ConnectModal id="modal-1" projectId={acme} />);
    fireEvent.click(screen.getByRole('button', { name: /^AWS/ }));
    expandAdvanced();
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

  it('key step (Advanced): Test connection saves once and shows the result without closing', async () => {
    render(<ConnectModal id="modal-1" projectId={acme} provider="gcp" />);
    expandAdvanced();
    fireEvent.change(screen.getByLabelText(copy.connect.key.name), { target: { value: 'gcp-infra' } });
    fireEvent.change(screen.getByLabelText(copy.connect.key.accessKey), { target: { value: 'sa@acme' } });
    fireEvent.change(screen.getByLabelText(copy.connect.key.secret), { target: { value: 'json' } });
    fireEvent.click(screen.getByRole('button', { name: copy.connect.key.test }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(copy.audit.actions.connected));
    fireEvent.click(screen.getByRole('button', { name: copy.connect.key.test }));
    await waitFor(() => expect(calls('target.test')).toHaveLength(2));
    expect(calls('target.connect.saveKey')).toHaveLength(1);
    expect(useUiStore.getState().overlays).toHaveLength(1);
  });

  it('reconnecting a key target opens with Advanced already expanded (prototype: Reconnect → AWS key step)', async () => {
    render(
      <ConnectModal id="modal-1" projectId={acme} provider="aws" targetId={fixtures.ids.target.awsProd} />,
    );
    expect(screen.getByRole('button', { name: /^Advanced/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText(copy.connect.key.accessKey)).toBeTruthy();
    await waitFor(() => expect(calls('target.connect.cliStatus')).toHaveLength(1));
    expect(calls('target.connect.cliLogin')).toHaveLength(0);
  });

  it('ssh step: Browse picks the key file via main; Save sends target.connect.saveSsh named after the host', async () => {
    render(<ConnectModal id="modal-1" projectId={acme} provider="ssh" />);
    expect(screen.getByRole('dialog').textContent).toContain('Connect target · SSH');
    const browse = screen.getByRole('button', { name: copy.connect.ssh.browse });
    expect(browse.hasAttribute('disabled')).toBe(false);
    fireEvent.click(browse);
    await waitFor(() =>
      expect((screen.getByLabelText(copy.connect.ssh.key) as HTMLInputElement).value).toBe(
        '/Users/me/.ssh/deploy_key',
      ),
    );
    expect(calls('dialog.pickFile')[0]?.[1]).toMatchObject({
      title: copy.connect.ssh.key,
      defaultPath: '~/.ssh',
    });
    expect(screen.getByText(copy.connect.ssh.body)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Advanced/ })).toBeNull();
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
      port: 22,
    });
    expect(calls('target.connect.cliStatus')).toHaveLength(0);
  });

  it('ssh step: a non-default port and a passphrase reach saveSsh; a bad port blocks Save', async () => {
    render(<ConnectModal id="modal-1" projectId={acme} provider="ssh" />);
    fireEvent.change(screen.getByLabelText(copy.connect.ssh.host), {
      target: { value: 'bastion.acme.internal' },
    });
    fireEvent.change(screen.getByLabelText(copy.connect.ssh.user), { target: { value: 'deploy' } });
    fireEvent.change(screen.getByLabelText(copy.connect.ssh.key), {
      target: { value: '~/.ssh/id_ed25519' },
    });
    const save = screen.getByRole('button', { name: copy.connect.ssh.save });
    // A port that is not a port must not reach the contract (which would reject it as an opaque failure).
    fireEvent.change(screen.getByLabelText(copy.connect.ssh.port), { target: { value: '22x' } });
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText(copy.connect.ssh.port), { target: { value: '2222' } });
    fireEvent.change(screen.getByLabelText(copy.connect.ssh.passphrase), {
      target: { value: 'hunter2' },
    });
    expect(save.hasAttribute('disabled')).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(calls('target.connect.saveSsh')).toHaveLength(1));
    expect(calls('target.connect.saveSsh')[0]?.[1]).toMatchObject({
      host: 'bastion.acme.internal',
      port: 2222,
      passphrase: 'hunter2',
    });
  });

  it('oauth (Advanced): Open browser starts the flow with the shared env', async () => {
    render(<ConnectModal id="modal-1" projectId={acme} provider="vercel" />);
    expandAdvanced();
    expect(screen.getByText(/macOS Keychain/)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'preview' }));
    fireEvent.click(screen.getByRole('button', { name: copy.connect.oauth.open }));
    await waitFor(() =>
      expect(commandMock).toHaveBeenCalledWith('target.connect.start', {
        projectId: acme,
        provider: 'vercel',
        env: 'preview',
      }),
    );
    expect(screen.getByText(copy.connect.oauth.waiting)).toBeTruthy();
  });

  it('oauth (Advanced): a null browserUrl switches to a masked token field saved via target.connect.saveToken', async () => {
    browserUrl = null;
    render(<ConnectModal id="modal-1" projectId={acme} provider="github" />);
    expandAdvanced();
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
    expandAdvanced();
    expect(screen.getByRole('button', { name: 'Save to Credential Manager' })).toBeTruthy();
    expect(screen.getByText(/Windows Credential Manager/)).toBeTruthy();
  });
});

const fill = (template: string, cli: string) => template.replaceAll('{cli}', cli);

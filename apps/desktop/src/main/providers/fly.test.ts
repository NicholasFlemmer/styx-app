import { copy, fill } from '@styx/core';
import { describe, expect, it, vi } from 'vitest';
import { MemoryVault } from '../services/credential-vault';
import { FakeCliRunner } from './cli-runner';
import { FlyAdapter } from './fly';
import type { AdapterDeps, GrantInfo, Scope, TargetInfo } from './types';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
/** Built, not written out, so no literal token shape sits in the repo. */
const PARENT = ['FlyV1', ' fm2', '_FIXTURE_PARENT_', 'x'.repeat(24)].join('');
const MINTED = ['FlyV1', ' fm2', '_FIXTURE_MINTED_', 'y'.repeat(24)].join('');
const APPS = JSON.stringify([
  { ID: 'acme-web', Name: 'acme-web', Organization: { Slug: 'acme' } },
  { ID: 'acme-web-staging', Name: 'acme-web-staging', Organization: { Slug: 'acme' } },
]);

const setup = (apps = APPS) => {
  const cli = new FakeCliRunner()
    .install('fly')
    .on('fly', ['version'], { stdout: 'fly v0.3.190 darwin/arm64 Commit: x' })
    .on('fly', ['auth', 'whoami', '--json'], { stdout: '{"email":"nic@acme.dev"}' })
    .on('fly', ['apps', 'list', '--json'], { stdout: apps })
    .on('fly', ['tokens', 'create'], { stdout: JSON.stringify({ token: MINTED }) })
    .on('fly', ['tokens', 'revoke', 'supplied'], { stdout: 'revoked' });
  const deps: AdapterDeps = {
    vault: new MemoryVault(),
    cli,
    now: () => NOW,
    fetch: vi.fn(async () => new Response('no network in tests', { status: 599 })) as unknown as typeof fetch,
  };
  return { cli, deps, fly: new FlyAdapter(deps) };
};
const target = (over: Partial<TargetInfo>): TargetInfo => ({
  id: 't1',
  provider: 'fly',
  name: 'Fly.io',
  env: 'prod',
  config: { app: 'acme-web' },
  credentialRef: null,
  ...over,
});
const grant = (scope: Scope[], over: Partial<GrantInfo> = {}): GrantInfo => ({
  id: 'g1',
  scope,
  duration: '1h',
  expiresAt: NOW + HOUR,
  ...over,
});

describe('FlyAdapter: connect', () => {
  it('cli mode stores only the account and the chosen app; the login stays with flyctl', async () => {
    const { fly, deps } = setup();
    const c = await fly.connect(
      { method: 'cli', account: 'nic@acme.dev', config: { app: 'acme-web' } },
      't1',
    );
    expect(c.credentialRef).toBe('styx:v1:fly:t1:cli');
    expect(JSON.parse((await deps.vault.get(c.credentialRef)) ?? '')).toEqual({
      kind: 'cli',
      account: 'nic@acme.dev',
    });
    expect(c.config).toEqual({ app: 'acme-web', account: 'nic@acme.dev' });
    await expect(fly.connect({ method: 'cli', account: 'someone@else.dev' }, 't1')).rejects.toThrow(
      /logged in as nic@acme.dev/,
    );
  });

  it('several apps need a pick (never the first); the only app is chosen for you', async () => {
    const { fly } = setup();
    await expect(fly.connect({ method: 'cli', account: 'cli' }, 't1')).rejects.toThrow(
      fill(copy.connect.project.choose, { provider: 'Fly.io' }),
    );
    await expect(
      fly.connect({ method: 'cli', account: 'cli', config: { app: 'gone' } }, 't1'),
    ).rejects.toThrow(/isn't in this Fly.io account/);
    const one = setup(JSON.stringify([{ Name: 'solo', Organization: { Slug: 'personal' } }]));
    expect((await one.fly.connect({ method: 'cli', account: 'cli' }, 't1')).config['app']).toBe('solo');
  });

  it('token mode checks the token through flyctl (env, never argv) and keeps it only in the vault', async () => {
    const { fly, deps, cli } = setup();
    const c = await fly.connect({ method: 'token', token: ` ${PARENT} `, config: { app: 'acme-web' } }, 't1');
    expect(c.credentialRef).toBe('styx:v1:fly:t1:oauth');
    expect(JSON.parse((await deps.vault.get(c.credentialRef)) ?? '')).toEqual({ token: PARENT });
    expect(JSON.stringify(c.config) + c.label).not.toContain('fm2_');
    for (const call of cli.calls) {
      expect(call.args.join(' ')).not.toContain('fm2_');
      expect(call.env).toEqual({ FLY_API_TOKEN: PARENT });
    }
  });
});

describe('FlyAdapter: issue and revoke', () => {
  it('a write, deploy or delete grant mints an app-scoped deploy token capped at the grant; never the stored login', async () => {
    const { fly, deps, cli } = setup();
    const ref = 'styx:v1:fly:t1:oauth';
    await deps.vault.set(ref, JSON.stringify({ token: PARENT }));
    const issued = await fly.issue(
      grant(['deploy'], { expiresAt: NOW + 30 * 60_000 }),
      target({ credentialRef: ref }),
    );
    expect(issued).toEqual({
      kind: 'env',
      env: { FLY_API_TOKEN: MINTED, FLY_APP: 'acme-web' },
      expiresAt: NOW + 30 * 60_000,
      scoped: false,
      handle: 'minted',
    });
    const mint = cli.calls.find((c) => c.args[0] === 'tokens');
    expect(mint?.args).toEqual([
      'tokens',
      'create',
      'deploy',
      '--app',
      'acme-web',
      '--expiry',
      '1800s',
      '--name',
      'styx-g1',
      '--json',
    ]);
    expect(mint?.env).toEqual({ FLY_API_TOKEN: PARENT });
  });

  it('a read-only grant mints a read-only token for the app’s org (scoped)', async () => {
    const { fly, deps, cli } = setup();
    await deps.vault.set('styx:v1:fly:t1:cli', JSON.stringify({ kind: 'cli', account: 'nic@acme.dev' }));
    const issued = await fly.issue(grant(['read']), target({ credentialRef: 'styx:v1:fly:t1:cli' }));
    expect(issued).toMatchObject({ scoped: true, env: { FLY_API_TOKEN: MINTED, FLY_APP: 'acme-web' } });
    const mint = cli.calls.find((c) => c.args[0] === 'tokens');
    expect(mint?.args.slice(0, 5)).toEqual(['tokens', 'create', 'readonly', '--org', 'acme']);
    // CLI mode: flyctl uses its own login; Styx passes no token of its own.
    expect(mint?.env).toBeUndefined();
  });

  it('session and always grants are minted for an hour at most and re-minted after', async () => {
    const { fly, deps } = setup();
    await deps.vault.set('styx:v1:fly:t1:cli', JSON.stringify({ kind: 'cli', account: 'x' }));
    const issued = await fly.issue(
      grant(['write'], { duration: 'always', expiresAt: null }),
      target({ credentialRef: 'styx:v1:fly:t1:cli' }),
    );
    expect(issued.expiresAt).toBe(NOW + HOUR);
  });

  it('fails closed: a failed mint, an unreadable mint, or an unchosen app among several throws', async () => {
    const { fly, deps, cli } = setup();
    await deps.vault.set('styx:v1:fly:t1:cli', JSON.stringify({ kind: 'cli', account: 'x' }));
    const t = target({ credentialRef: 'styx:v1:fly:t1:cli' });
    await expect(fly.issue(grant(['write']), { ...t, config: {} })).rejects.toThrow(/several projects/);
    cli.on('fly', ['tokens', 'create'], { stdout: 'not json' });
    await expect(fly.issue(grant(['write']), t)).rejects.toThrow(/could not read/);
    cli.on('fly', ['tokens', 'create'], { exitCode: 1, stderr: 'Error: not authorized to create tokens' });
    await expect(fly.issue(grant(['write']), t)).rejects.toThrow(/not authorized/);
  });

  it('revoke revokes the minted token upstream, and only a minted one', async () => {
    const { fly, cli } = setup();
    await fly.revoke({
      kind: 'env',
      env: { FLY_API_TOKEN: MINTED },
      expiresAt: null,
      scoped: false,
      handle: 'minted',
    });
    const call = cli.calls.find((c) => c.args[0] === 'tokens');
    expect(call).toEqual({
      bin: 'fly',
      args: ['tokens', 'revoke', 'supplied'],
      env: { FLY_API_TOKEN: MINTED },
    });
    cli.calls.length = 0;
    await fly.revoke({ kind: 'env', env: { FLY_API_TOKEN: PARENT }, expiresAt: null, scoped: false });
    expect(cli.calls).toEqual([]);
  });

  it('issuesScoped only for read-only grants', () => {
    const { fly } = setup();
    expect(fly.issuesScoped(['read'])).toBe(true);
    expect(fly.issuesScoped(['read', 'write'])).toBe(false);
    expect(fly.issuesScoped(['deploy'])).toBe(false);
    expect(fly.issuesScoped([])).toBe(false);
  });
});

describe('FlyAdapter: review fixes', () => {
  it.each([
    [['deploy', '--app', 'acme-web'], 'acme-web'],
    [['deploy', '--app=acme-web'], 'acme-web'],
    [['deploy', '-a', 'acme-web'], 'acme-web'],
    [['deploy', '-aacme-web'], 'acme-web'],
    [['deploy', '-a', 'x', '-a', 'y'], 'y'],
    [['deploy', '--config', 'acme-web'], null],
    [['ssh', 'console', '--', '-a', 'x'], null],
  ])('projectOfCommand %j → %s', (argv, app) => {
    expect(setup().fly.projectOfCommand(argv)).toBe(app);
  });

  it('caps every token at an hour even when a session grant runs longer', async () => {
    const { fly, deps, cli } = setup();
    await deps.vault.set('styx:v1:fly:t1:cli', JSON.stringify({ kind: 'cli', account: 'x' }));
    const issued = await fly.issue(
      grant(['write'], { duration: 'session', expiresAt: NOW + 8 * HOUR }),
      target({ credentialRef: 'styx:v1:fly:t1:cli' }),
    );
    expect(issued.expiresAt).toBe(NOW + HOUR);
    expect(cli.calls.find((c) => c.args[0] === 'tokens')?.args).toContain('3600s');
  });

  it('a failed upstream revoke does not throw (the token’s own expiry still ends it)', async () => {
    const { fly, cli } = setup();
    cli.on('fly', ['tokens', 'revoke', 'supplied'], { exitCode: 1, stderr: 'Error: boom' });
    await expect(
      fly.revoke({
        kind: 'env',
        env: { FLY_API_TOKEN: MINTED },
        expiresAt: null,
        scoped: false,
        handle: 'minted',
      }),
    ).resolves.toBeUndefined();
  });

  it('a malformed keychain entry is refused, never handed on as `undefined`', async () => {
    const { fly, deps } = setup();
    await deps.vault.set('styx:v1:fly:t1:oauth', JSON.stringify({ nope: 1 }));
    await expect(
      fly.issue(grant(['write']), target({ credentialRef: 'styx:v1:fly:t1:oauth' })),
    ).rejects.toThrow(/malformed/);
  });
});

describe('FlyAdapter: status, health, deploy', () => {
  it('cliStatus names the binary, version and the logged-in account; falls back to flyctl', async () => {
    const { fly } = setup();
    expect(await fly.cliStatus()).toEqual({
      installed: true,
      binary: '/usr/local/bin/fly',
      version: '0.3.190',
      loginCommand: 'fly auth login',
      accounts: [{ id: 'nic@acme.dev', label: 'nic@acme.dev', active: true }],
    });
    const only = new FakeCliRunner()
      .install('flyctl')
      .on('flyctl', ['auth', 'whoami'], { exitCode: 1, stderr: 'Error: not logged in' });
    const status = await new FlyAdapter({ ...setup().deps, cli: only }).cliStatus();
    expect(status).toMatchObject({ installed: true, binary: '/usr/local/bin/flyctl', accounts: [] });
    expect(await new FlyAdapter({ ...setup().deps, cli: new FakeCliRunner() }).cliStatus()).toMatchObject({
      installed: false,
    });
    expect(fly.cliLoginCommand()).toEqual({ bin: 'fly', args: ['auth', 'login'] });
  });

  it('health: a logged-out CLI is an expiry; a missing binary or an unchosen app is not', async () => {
    const { fly, deps, cli } = setup();
    await deps.vault.set('styx:v1:fly:t1:cli', JSON.stringify({ kind: 'cli', account: 'x' }));
    const t = target({ credentialRef: 'styx:v1:fly:t1:cli' });
    expect(await fly.health(t)).toEqual({ ok: true, identity: 'acme-web (nic@acme.dev)' });
    expect(await fly.health({ ...t, config: {} })).toMatchObject({ ok: false, expired: false });
    cli.on('fly', ['auth', 'whoami'], {
      exitCode: 1,
      stderr: 'Error: You must be authenticated to view this.',
    });
    expect(await fly.health(t)).toMatchObject({ ok: false, expired: true });
    cli.on('fly', ['auth', 'whoami'], {
      exitCode: 1,
      stderr: "Error: No access token available. Please login with 'flyctl auth login'",
    });
    expect(await fly.health(t)).toMatchObject({ ok: false, expired: true });
    const gone = new FlyAdapter({ ...deps, cli: new FakeCliRunner() });
    expect(await gone.health(t)).toMatchObject({ ok: false, expired: false });
  });

  it('deployCommand deploys the target’s app', () => {
    const { fly } = setup();
    expect(fly.deployCommand(target({}))).toEqual({ bin: 'fly', args: ['deploy', '--app', 'acme-web'] });
    expect(fly.deployCommand(target({ config: { app: '-x' } }))).toEqual({ bin: 'fly', args: ['deploy'] });
  });
});

describe('FlyAdapter: scope classification', () => {
  const { fly } = setup();
  it.each<[string[], Scope]>([
    // delete
    [['apps', 'destroy', 'acme-web', '--yes'], 'delete'],
    [['destroy', 'acme-web'], 'delete'],
    [['machine', 'destroy', '148e'], 'delete'],
    [['machines', 'rm', '148e', '--force'], 'delete'],
    [['volumes', 'delete', 'vol_1'], 'delete'],
    [['secrets', 'unset', 'DATABASE_URL'], 'delete'],
    [['ips', 'release', '1.2.3.4'], 'delete'],
    [['certs', 'remove', 'shop.example'], 'delete'],
    [['tokens', 'revoke', 'tok_1'], 'delete'],
    [['postgres', 'detach', 'acme-db'], 'delete'],
    // deploy
    [['deploy'], 'deploy'],
    [['deploy', '--app', 'acme-web', '--remote-only'], 'deploy'],
    [['launch'], 'deploy'],
    [['apps', 'restart', 'acme-web'], 'deploy'],
    [['machine', 'restart', '148e'], 'deploy'],
    [['image', 'update'], 'deploy'],
    [['secrets', 'deploy'], 'deploy'],
    // write: secrets, scaling, shells, tunnels, file transfer, token minting, auth changes
    [['secrets', 'set', 'X=1'], 'write'],
    [['secrets', 'import'], 'write'],
    [['scale', 'count', '3'], 'write'],
    [['ssh', 'console'], 'write'],
    [['ssh', 'console', '-C', 'cat /etc/passwd'], 'write'],
    [['ssh', 'sftp', 'get', '/data/db.sqlite'], 'write'],
    [['sftp', 'shell'], 'write'],
    [['console'], 'write'],
    [['proxy', '5432'], 'write'],
    [['machine', 'exec', '148e', 'ls'], 'write'],
    [['machine', 'run', 'alpine'], 'write'],
    [['pg', 'connect'], 'write'],
    [['tokens', 'create', 'deploy'], 'write'],
    [['auth', 'token'], 'write'],
    [['auth', 'login'], 'write'],
    [['wireguard', 'list'], 'write'],
    [['config', 'save'], 'write'],
    // reads
    [['status'], 'read'],
    [['status', '--app', 'acme-web'], 'read'],
    [['logs', '-a', 'acme-web'], 'read'],
    [['apps', 'list'], 'read'],
    [['machine', 'list'], 'read'],
    [['machine', 'status', '148e'], 'read'],
    [['secrets', 'list'], 'read'],
    [['releases'], 'read'],
    [['tokens', 'list'], 'read'],
    [['auth', 'whoami'], 'read'],
    [['config', 'show'], 'read'],
    [['platform', 'regions'], 'read'],
    [['--help'], 'read'],
    [['deploy', '--help'], 'read'],
    [[], 'read'],
    // help is only help at the end, never after `--`, never as a flag's value (security review H1)
    [['ssh', 'console', '-C', 'ls', '--help'], 'write'],
    [['machine', 'run', 'img', '-v', 'vol:/data'], 'write'],
    [['secrets', 'set', '--app', '--help'], 'write'],
    // a boolean flag in front can't shift the command words (H2)
    [['--debug', 'deploy', 'logs'], 'deploy'],
    [['--verbose', 'apps', 'destroy', 'x'], 'delete'],
    // …nor can a flag between command words hide a delete or deploy (second review L1)
    [['machine', '--app', 'acme-web', 'destroy', '148e'], 'delete'],
    [['apps', '-a', 'x', 'restart'], 'deploy'],
    [['logs', '--app', 'acme-web'], 'read'],
    // a mix of valued and boolean flags in between (third review L-A)
    [['machine', '-a', 'x', '--verbose', 'destroy', 'id'], 'delete'],
    [['secrets', '-a', 'x', '--stage', 'unset', 'K'], 'delete'],
    [['apps', '-o', 'personal', '--json', 'destroy', 'x'], 'delete'],
    [['status', '-a', 'acme-web', '--json'], 'read'],
    [['secrets', 'list', '-a', 'acme-web', '--json'], 'read'],
    // fails closed: unknown verbs, flags only, read-looking words in flag values
    [['frobnicate'], 'write'],
    [['-a', 'acme-web'], 'write'],
    [['secrets', 'set', '--app', 'list'], 'write'],
    [['scale', 'show'], 'read'],
  ])('fly %j → %s', (argv, scope) => {
    expect(fly.scopeOfCommand(argv)).toEqual([scope]);
  });
});

import { copy, fill } from '@styx/core';
import { describe, expect, it, vi } from 'vitest';
import { MemoryVault } from '../services/credential-vault';
import { FakeCliRunner } from './cli-runner';
import { parseRenderCliConfig, RenderAdapter } from './render';
import type { AdapterDeps, GrantInfo, ProviderAdapter, Scope, TargetInfo } from './types';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
/** Built, not written out, so no literal key shape sits in the repo. */
const KEY = ['rnd', '_FIXTURE', 'z'.repeat(24)].join('');
const CLI_YAML = '/Users/test/.render/cli.yaml';
const SERVICES = [
  {
    service: {
      id: 'srv-web123',
      name: 'acme-web',
      type: 'web_service',
      serviceDetails: { region: 'oregon' },
    },
  },
  { service: { id: 'srv-wrk456', name: 'acme-worker', type: 'background_worker', serviceDetails: {} } },
];

const setup = (opts: { status?: number; services?: unknown } = {}, cli = new FakeCliRunner()) => {
  const seen: string[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get('authorization') ?? '');
    if (opts.status !== undefined) return new Response('{"message":"unauthorized"}', { status: opts.status });
    const u = String(url);
    if (u.startsWith('https://api.render.com/v1/services'))
      return new Response(JSON.stringify(opts.services ?? SERVICES), { status: 200 });
    if (u.startsWith('https://api.render.com/v1/owners'))
      return new Response(JSON.stringify([{ owner: { id: 'tea-1', name: 'Nic', email: 'nic@acme.dev' } }]), {
        status: 200,
      });
    return new Response('nope', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  const deps: AdapterDeps = { vault: new MemoryVault(), cli, now: () => NOW, fetch };
  return { deps, seen, cli, render: new RenderAdapter(deps) };
};
const target = (over: Partial<TargetInfo>): TargetInfo => ({
  id: 't1',
  provider: 'render',
  name: 'Render',
  env: 'prod',
  config: { serviceId: 'srv-web123' },
  credentialRef: 'styx:v1:render:t1:oauth',
  ...over,
});
const grant = (scope: Scope[], over: Partial<GrantInfo> = {}): GrantInfo => ({
  id: 'g1',
  scope,
  duration: '1h',
  expiresAt: NOW + HOUR,
  ...over,
});
const yaml = (key: string, expiresAt: number) =>
  `version: 1\nworkspace: tea-1\nworkspace_name: Acme\nuser_email: nic@acme.dev\napi:\n  key: "${key}"\n  expires_at: ${expiresAt}\n  host: https://api.render.com/v1/\n`;

describe('parseRenderCliConfig', () => {
  it('reads only api.key, api.expires_at, user_email and workspace_name', () => {
    expect(parseRenderCliConfig(yaml('rnd_x', 1_800_003_600))).toEqual({
      key: 'rnd_x',
      expiresAt: 1_800_003_600_000,
      email: 'nic@acme.dev',
      workspace: 'Acme',
    });
    // A `key` outside the api block is not the token; expires_at 0 means none.
    expect(parseRenderCliConfig('key: nope\napi:\n  expires_at: 0\n# key: commented\n')).toEqual({
      key: null,
      expiresAt: null,
      email: null,
      workspace: null,
    });
  });
});

describe('RenderAdapter: connect', () => {
  it('API key: verified, a service picked (never the first of several), stored only in the vault', async () => {
    const { render, deps, seen } = setup();
    await expect(render.connect({ method: 'token', token: KEY }, 't1')).rejects.toThrow(
      fill(copy.connect.project.choose, { provider: 'Render' }),
    );
    const c = await render.connect(
      { method: 'token', token: KEY, config: { serviceId: 'srv-web123' } },
      't1',
    );
    expect(c.credentialRef).toBe('styx:v1:render:t1:oauth');
    expect(JSON.parse((await deps.vault.get(c.credentialRef)) ?? '')).toEqual({ token: KEY });
    expect(c.config).toEqual({ serviceId: 'srv-web123', account: 'nic@acme.dev' });
    expect(JSON.stringify(c.config) + c.label).not.toContain('rnd_');
    expect(seen.every((h) => h === `Bearer ${KEY}`)).toBe(true);
    expect(await render.listProjects({ kind: 'token', token: KEY })).toEqual([
      { id: 'srv-web123', name: 'acme-web', region: 'oregon' },
      { id: 'srv-wrk456', name: 'acme-worker', region: 'background_worker' },
    ]);
  });

  it('a rejected key never connects, and the response body is not echoed', async () => {
    const { render, deps } = setup({ status: 401 });
    await expect(render.connect({ method: 'token', token: KEY }, 't1')).rejects.toThrow(
      /^Render rejected the token \(401\)$/,
    );
    expect(await deps.vault.get('styx:v1:render:t1:oauth')).toBeNull();
  });

  it('cli mode reads the token `render login` keeps, on every use, and stores only the account', async () => {
    const cli = new FakeCliRunner()
      .install('render')
      .file(CLI_YAML, yaml('FIXTURE-cli-token', NOW / 1000 + 3600));
    const { render, deps, seen } = setup({}, cli);
    const c = await render.connect(
      { method: 'cli', account: 'cli', config: { serviceId: 'srv-web123' } },
      't1',
    );
    expect(JSON.parse((await deps.vault.get(c.credentialRef)) ?? '')).toEqual({
      kind: 'cli',
      account: 'cli',
    });
    expect(seen.at(-1)).toBe('Bearer FIXTURE-cli-token');
    const issued = await render.issue(grant(['read']), target({ credentialRef: c.credentialRef }));
    // The CLI token's own expiry caps the bundle.
    expect(issued).toEqual({
      kind: 'env',
      env: { RENDER_API_KEY: 'FIXTURE-cli-token', RENDER_OUTPUT: 'text' },
      expiresAt: NOW + HOUR,
      scoped: false,
    });
  });

  it('cli mode: logged out or expired (and not refreshed by the CLI) is an expiry; RENDER_CLI_CONFIG_PATH is honoured', async () => {
    const cli = new FakeCliRunner({ env: { RENDER_CLI_CONFIG_PATH: '~/work/render.yaml' } }).install(
      'render',
    );
    const { render, deps } = setup({}, cli);
    await deps.vault.set('styx:v1:render:t1:cli', JSON.stringify({ kind: 'cli', account: 'cli' }));
    const t = target({ credentialRef: 'styx:v1:render:t1:cli' });
    expect(await render.health(t)).toMatchObject({ ok: false, expired: true });
    cli.file('/Users/test/work/render.yaml', yaml('FIXTURE-old', NOW / 1000 - 5));
    expect(await render.health(t)).toMatchObject({ ok: false, expired: true });
    expect(cli.calls.some((c) => c.args[0] === 'workspaces')).toBe(true); // gave the CLI a chance to refresh
    cli.file('/Users/test/work/render.yaml', yaml('FIXTURE-new', NOW / 1000 + 600));
    expect(await render.health(t)).toEqual({ ok: true, identity: 'acme-web (srv-web123)' });
  });
});

describe('RenderAdapter: issue, health, deploy', () => {
  it('hands the stored key over unscoped (Render cannot narrow it) and has nothing to revoke', async () => {
    const { render, deps } = setup();
    await deps.vault.set('styx:v1:render:t1:oauth', JSON.stringify({ token: KEY }));
    expect(await render.issue(grant(['deploy']), target({}))).toEqual({
      kind: 'env',
      env: { RENDER_API_KEY: KEY, RENDER_OUTPUT: 'text' },
      expiresAt: NOW + HOUR,
      scoped: false,
    });
    expect(('issuesScoped' satisfies keyof ProviderAdapter) in render).toBe(false);
    await expect(render.revoke()).resolves.toBeUndefined();
  });

  it('fails closed: a target naming no service among several is refused', async () => {
    const { render, deps } = setup();
    await deps.vault.set('styx:v1:render:t1:oauth', JSON.stringify({ token: KEY }));
    await expect(render.issue(grant(['read']), target({ config: {} }))).rejects.toThrow(/several projects/);
    const one = setup({ services: [SERVICES[0]] });
    await one.deps.vault.set('styx:v1:render:t1:oauth', JSON.stringify({ token: KEY }));
    await expect(one.render.issue(grant(['read']), target({ config: {} }))).resolves.toMatchObject({
      kind: 'env',
    });
  });

  it('health: 401 is an expiry, an unchosen service is not', async () => {
    const rejected = setup({ status: 401 });
    await rejected.deps.vault.set('styx:v1:render:t1:oauth', JSON.stringify({ token: KEY }));
    expect(await rejected.render.health(target({}))).toMatchObject({ ok: false, expired: true });
    const ok = setup();
    await ok.deps.vault.set('styx:v1:render:t1:oauth', JSON.stringify({ token: KEY }));
    expect(await ok.render.health(target({ config: {} }))).toMatchObject({ ok: false, expired: false });
    const down = setup({ status: 503 });
    await down.deps.vault.set('styx:v1:render:t1:oauth', JSON.stringify({ token: KEY }));
    expect(await down.render.health(target({}))).toMatchObject({ ok: false, expired: false });
  });

  it('cliStatus: binary, version and the logged-in email from cli.yaml', async () => {
    const cli = new FakeCliRunner()
      .install('render')
      .on('render', ['--version'], { stdout: 'render version 2.4.2' })
      .file(CLI_YAML, yaml('FIXTURE', NOW / 1000 + 600));
    const { render } = setup({}, cli);
    expect(await render.cliStatus()).toEqual({
      installed: true,
      binary: '/usr/local/bin/render',
      version: '2.4.2',
      loginCommand: 'render login',
      accounts: [{ id: 'cli', label: 'nic@acme.dev', active: true, detail: 'Acme' }],
    });
    cli.files.clear();
    expect((await render.cliStatus()).accounts).toEqual([]);
    expect(await setup().render.cliStatus()).toMatchObject({ installed: false });
    expect(render.cliLoginCommand()).toEqual({ bin: 'render', args: ['login'] });
  });

  it('deployCommand triggers a deploy of the target’s service and waits for it', () => {
    const { render } = setup();
    expect(render.deployCommand(target({}))).toEqual({
      bin: 'render',
      args: ['deploys', 'create', 'srv-web123', '--confirm', '--wait'],
    });
  });
});

describe('RenderAdapter: scope classification', () => {
  const { render } = setup();
  it.each<[string[], Scope]>([
    [['services', 'delete', 'srv-1'], 'delete'],
    [['delete', 'srv-1'], 'delete'],
    [['deploys', 'create', 'srv-1', '--confirm'], 'deploy'],
    [['deploys', 'create'], 'deploy'],
    [['restart', 'srv-1'], 'deploy'],
    [['services', 'restart', 'srv-1'], 'deploy'],
    [['blueprints', 'launch'], 'deploy'],
    [['services', 'create', '--repo', 'x'], 'write'],
    [['deploys', 'cancel', 'dep-1'], 'write'],
    [['jobs', 'create', 'srv-1', '--start-command', 'rake db:migrate'], 'write'],
    [['ssh', 'srv-1'], 'write'],
    [['ssh', 'srv-1', '--ephemeral'], 'write'],
    [['psql', 'dpg-1', '-c', 'select 1'], 'write'],
    [['workspace', 'set', 'tea-1'], 'write'],
    [['login'], 'write'],
    // The TUI offers deploy / restart from a list: never a read.
    [['services', '-o', 'interactive'], 'write'],
    [['deploys', 'list', '--output=interactive'], 'write'],
    [['services', '-ointeractive'], 'write'],
    [['services'], 'read'],
    [['services', '-o', 'json'], 'read'],
    [['services', 'list'], 'read'],
    [['deploys', 'list', 'srv-1'], 'read'],
    [['logs', '-r', 'srv-1'], 'read'],
    [['workspaces'], 'read'],
    [['workspace', 'current'], 'read'],
    [['jobs', 'list', 'srv-1'], 'read'],
    [['blueprints', 'validate'], 'read'],
    [['--help'], 'read'],
    [['deploys', 'create', '--help'], 'read'],
    [[], 'read'],
    // help only at the end and never inside a shell or as a flag's value (security review H1)
    [['ssh', 'srv-abc', '--', 'sh', '-c', 'x', '--help'], 'write'],
    [['ssh', 'srv-abc', '--help'], 'write'],
    [['psql', 'dpg-1', '--', '-c', 'DROP TABLE x', '-h', 'host'], 'write'],
    [['services', 'create', '--name', '--help'], 'write'],
    // a boolean flag in front can't shift the command words (H2)
    [['--confirm', 'deploys', 'create', 'srv-1'], 'deploy'],
    [['services', '-o', 'json', 'delete', 'srv-1'], 'delete'],
    [['frobnicate'], 'write'],
    [['-o', 'json'], 'write'],
    [['services', 'srv-1'], 'write'],
  ])('render %j → %s', (argv, scope) => {
    expect(render.scopeOfCommand(argv)).toEqual([scope]);
  });
});

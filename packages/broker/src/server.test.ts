import { chmodSync, mkdirSync, mkdtempSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrokerClient, BrokerClientError } from './client';
import { assertPrivateDir, BrokerServer, BrokerError } from './server';
import { ErrorCode, type SessionBrief } from './protocol';
import { brokerEndpoint } from './endpoint';

const session: SessionBrief = { sessionId: 's1', projectId: 'p1', projectName: 'acme-shop', worktreePath: '/tmp/wt', branch: 'agent/codex-1', agent: 'codex' };
const TOKEN = 'a'.repeat(32);
let server: BrokerServer;
let path: string;
let now = 1_800_000_000_000;

beforeEach(async () => {
  path = join(mkdtempSync(join(tmpdir(), 'styx-brk-')), 'b.sock');
  server = new BrokerServer({
    authenticate: async (sid, tok) => (sid === 's1' && tok === TOKEN ? session : null),
    rateLimitPerMinute: 2,
    now: () => now,
  });
  await server.listen(path);
});
afterEach(async () => server.close());

const client = () => new BrokerClient({ endpoint: path, sessionId: 's1', token: TOKEN, client: 'mcp', pid: 1 });

describe('BrokerServer', () => {
  it('computes endpoints per platform', () => {
    expect(brokerEndpoint({ platform: 'darwin', uid: 501, username: 'nic', userData: '/x', tmpdir: '/tmp' })).toBe('/tmp/styx-501/broker.sock');
    expect(brokerEndpoint({ platform: 'win32', uid: 0, username: 'Nic F', userData: 'C:\\u' })).toMatch(/^\\\\\.\\pipe\\styx-Nic_F-[0-9a-f]{8}$/);
    // L2: the per-user secret makes the pipe name unguessable; non-alphanumerics are stripped.
    expect(brokerEndpoint({ platform: 'win32', uid: 0, username: 'nic', userData: 'C:\\u', secret: 'dead-beef' })).toMatch(/^\\\\\.\\pipe\\styx-nic-[0-9a-f]{8}-deadbeef$/);
  });

  it('rejects bad tokens and unauthenticated calls', async () => {
    const bad = new BrokerClient({ endpoint: path, sessionId: 's1', token: 'b'.repeat(32), client: 'cli', pid: 2 });
    await expect(bad.connect()).rejects.toMatchObject({ code: ErrorCode.unauthenticated });
  });

  it('authenticates, dispatches, validates results, and maps BrokerError codes', async () => {
    server.on('list_targets', async (_p, ctx) => [{ name: `t-${ctx.session.projectName}`, provider: 'vercel', env: 'prod', lockState: 'locked', scopes: ['deploy'] }]);
    server.on('get_credential', async () => {
      throw new BrokerError(ErrorCode.revoked, 'grant revoked');
    });
    const c = client();
    const s = await c.connect();
    expect(s.projectName).toBe('acme-shop');
    expect(await c.call('list_targets', {})).toEqual([{ name: 't-acme-shop', provider: 'vercel', env: 'prod', lockState: 'locked', scopes: ['deploy'] }]);
    await expect(c.call('get_credential', { grantId: 'g' })).rejects.toMatchObject({ code: ErrorCode.revoked, message: 'grant revoked' });
    await expect(c.call('request_access', { target: '', scope: [], reason: '' } as never)).rejects.toMatchObject({ code: ErrorCode.invalidParams });
    c.close();
  });

  it('holds request_access until resolved from the app side, and pushes notifications', async () => {
    server.on('request_access', async (p, _ctx, req) => {
      req.hold(`grant:${p.target}`);
      return undefined as never;
    });
    const c = client();
    await c.connect();
    const revoked: string[] = [];
    c.onNotification('grant.revoked', (n) => revoked.push(n.grantId));
    const pending = c.call('request_access', { target: 'supabase-prod', scope: ['write'], reason: 'migration 0042', waitMs: 1000 });
    await new Promise((r) => setTimeout(r, 20));
    expect(server.heldKeys()).toEqual(['grant:supabase-prod']);
    expect(server.resolveHeld('grant:supabase-prod', { status: 'active', grantId: 'g1', scope: ['write'], expiresAt: null, decidedBy: 'user' })).toBe(true);
    await expect(pending).resolves.toMatchObject({ status: 'active', grantId: 'g1' });
    server.notify('s1', 'grant.revoked', { grantId: 'g1', reason: 'user' });
    await new Promise((r) => setTimeout(r, 20));
    expect(revoked).toEqual(['g1']);
    c.close();
  });

  it('rate-limits request_access per session', async () => {
    server.on('request_access', async () => ({ status: 'denied', grantId: 'x' }));
    const c = client();
    await c.connect();
    const req = () => c.call('request_access', { target: 't', scope: ['read'], reason: 'r' });
    await req();
    await req();
    await expect(req()).rejects.toMatchObject({ code: ErrorCode.rateLimited });
    now += 61_000;
    await expect(req()).resolves.toMatchObject({ status: 'denied' });
    c.close();
  });

  it('fromEnv requires the session env', () => {
    expect(() => BrokerClient.fromEnv('shim', {})).toThrow(/Not inside a Styx session/);
    expect(BrokerClient.fromEnv('shim', { STYX_BROKER: path, STYX_SESSION_ID: 's1', STYX_TOKEN: TOKEN })).toBeInstanceOf(BrokerClient);
    expect(new BrokerClientError(1, 'x').code).toBe(1);
  });
});

describe('BrokerServer hardening', () => {
  it('L3: refuses a second hello on a bound connection and drops it', async () => {
    server.on('list_targets', async () => []);
    const c = client();
    await c.connect();
    await expect(c.call('hello', { v: 1, sessionId: 's1', token: TOKEN, client: 'mcp', pid: 1 })).rejects.toMatchObject({ code: ErrorCode.invalidRequest });
    await new Promise((r) => setTimeout(r, 30));
    expect(server.connectionCount()).toBe(0);
    await expect(c.call('list_targets', {}, { timeoutMs: 200 })).rejects.toBeTruthy(); // nothing answers any more
    c.close();
  });

  it('L1: ask_user shares the per-session bucket, and allow() is public for host-metered paths', async () => {
    server.on('ask_user', async () => ({ resolution: { kind: 'question', answer: 'y' } }));
    const c = client();
    await c.connect();
    await c.call('ask_user', { kind: 'question', payload: {}, waitMs: 0 });
    expect(server.allow('s1')).toBe(true); // second slot, consumed by the host
    await expect(c.call('ask_user', { kind: 'question', payload: {}, waitMs: 0 })).rejects.toMatchObject({ code: ErrorCode.rateLimited });
    expect(server.allow('s1')).toBe(false);
    now += 61_000;
    expect(server.allow('s1')).toBe(true);
    c.close();
  });

  it.skipIf(process.platform === 'win32')('L2: the socket directory must be ours, 0700 and not a symlink; the socket is born 0600', async () => {
    expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
    const base = mkdtempSync(join(tmpdir(), 'styx-brk-'));
    const open = join(base, 'open');
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    expect(() => assertPrivateDir(open)).toThrow(/mode 755/);
    const link = join(base, 'link');
    symlinkSync(base, link);
    expect(() => assertPrivateDir(link)).toThrow(/not a directory/);
    const s2 = new BrokerServer({ authenticate: async () => null });
    await expect(s2.listen(join(open, 'b.sock'))).rejects.toThrow(/expected 0700/);
    await s2.close();
  });
});

import { chmodSync, mkdirSync, mkdtempSync, statSync, symlinkSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrokerClient, BrokerClientError } from './client';
import { assertPrivateDir, BrokerServer, BrokerError } from './server';
import { ErrorCode, type SessionBrief } from './protocol';
import { brokerEndpoint } from './endpoint';

const session: SessionBrief = {
  sessionId: 's1',
  projectId: 'p1',
  projectName: 'acme-shop',
  worktreePath: '/tmp/wt',
  branch: 'agent/codex-1',
  agent: 'codex',
};
const TOKEN = 'a'.repeat(32);
let server: BrokerServer;
let path: string;
let now = 1_800_000_000_000;

beforeEach(async () => {
  path = join(mkdtempSync(join(tmpdir(), 'styx-brk-')), 'b.sock');
  server = new BrokerServer({
    authenticate: async (sid, tok) => (sid === 's1' && tok === TOKEN ? session : null),
    rateLimitPerMinute: 2,
    askRateLimitPerMinute: 3,
    now: () => now,
  });
  await server.listen(path);
});
afterEach(async () => server.close());

const client = () =>
  new BrokerClient({ endpoint: path, sessionId: 's1', token: TOKEN, client: 'mcp', pid: 1 });

describe('BrokerServer', () => {
  it('computes endpoints per platform', () => {
    expect(
      brokerEndpoint({ platform: 'darwin', uid: 501, username: 'nic', userData: '/x', tmpdir: '/tmp' }),
    ).toMatch(/^\/tmp\/styx-501\/broker-[0-9a-f]{8}\.sock$/);
    // Per user-data dir: a second instance (dev, e2e, another profile) gets its own socket and cannot steal this one's.
    expect(
      brokerEndpoint({ platform: 'darwin', uid: 501, username: 'nic', userData: '/x', tmpdir: '/tmp' }),
    ).toBe(brokerEndpoint({ platform: 'darwin', uid: 501, username: 'nic', userData: '/x', tmpdir: '/tmp' }));
    expect(
      brokerEndpoint({ platform: 'darwin', uid: 501, username: 'nic', userData: '/y', tmpdir: '/tmp' }),
    ).not.toBe(
      brokerEndpoint({ platform: 'darwin', uid: 501, username: 'nic', userData: '/x', tmpdir: '/tmp' }),
    );
    expect(brokerEndpoint({ platform: 'win32', uid: 0, username: 'Nic F', userData: 'C:\\u' })).toMatch(
      /^\\\\\.\\pipe\\styx-Nic_F-[0-9a-f]{8}$/,
    );
    // L2: the per-user secret makes the pipe name unguessable; non-alphanumerics are stripped.
    expect(
      brokerEndpoint({ platform: 'win32', uid: 0, username: 'nic', userData: 'C:\\u', secret: 'dead-beef' }),
    ).toMatch(/^\\\\\.\\pipe\\styx-nic-[0-9a-f]{8}-deadbeef$/);
  });

  it('rejects bad tokens and unauthenticated calls', async () => {
    const bad = new BrokerClient({
      endpoint: path,
      sessionId: 's1',
      token: 'b'.repeat(32),
      client: 'cli',
      pid: 2,
    });
    await expect(bad.connect()).rejects.toMatchObject({ code: ErrorCode.unauthenticated });
  });

  it('authenticates, dispatches, validates results, and maps BrokerError codes', async () => {
    server.on('list_targets', async (_p, ctx) => [
      {
        id: 'tgt-1',
        name: `t-${ctx.session.projectName}`,
        provider: 'vercel',
        env: 'prod',
        lockState: 'locked',
        scopes: ['deploy'],
      },
    ]);
    server.on('get_credential', async () => {
      throw new BrokerError(ErrorCode.revoked, 'grant revoked');
    });
    const c = client();
    const s = await c.connect();
    expect(s.projectName).toBe('acme-shop');
    expect(await c.call('list_targets', {})).toEqual([
      { id: 'tgt-1', name: 't-acme-shop', provider: 'vercel', env: 'prod', lockState: 'locked', scopes: ['deploy'] },
    ]);
    await expect(c.call('get_credential', { grantId: 'g' })).rejects.toMatchObject({
      code: ErrorCode.revoked,
      message: 'grant revoked',
    });
    await expect(
      c.call('request_access', { target: '', scope: [], reason: '' } as never),
    ).rejects.toMatchObject({ code: ErrorCode.invalidParams });
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
    const pending = c.call('request_access', {
      target: 'supabase-prod',
      scope: ['write'],
      reason: 'migration 0042',
      waitMs: 1000,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(server.heldKeys()).toEqual(['grant:supabase-prod']);
    expect(
      server.resolveHeld('grant:supabase-prod', {
        status: 'active',
        grantId: 'g1',
        scope: ['write'],
        expiresAt: null,
        decidedBy: 'user',
      }),
    ).toBe(true);
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
    expect(
      BrokerClient.fromEnv('shim', { STYX_BROKER: path, STYX_SESSION_ID: 's1', STYX_TOKEN: TOKEN }),
    ).toBeInstanceOf(BrokerClient);
    expect(new BrokerClientError(1, 'x').code).toBe(1);
  });
});

describe('BrokerServer hardening', () => {
  it('L3: refuses a second hello on a bound connection and drops it', async () => {
    server.on('list_targets', async () => []);
    const c = client();
    await c.connect();
    await expect(
      c.call('hello', { v: 1, sessionId: 's1', token: TOKEN, client: 'mcp', pid: 1 }),
    ).rejects.toMatchObject({ code: ErrorCode.invalidRequest });
    await new Promise((r) => setTimeout(r, 30));
    expect(server.connectionCount()).toBe(0);
    await expect(c.call('list_targets', {}, { timeoutMs: 200 })).rejects.toBeTruthy(); // nothing answers any more
    c.close();
  });

  it('L1: ask_user has its own (larger) bucket; allow() is public so the host can meter exec_authorize into the request bucket', async () => {
    server.on('ask_user', async () => ({ resolution: { kind: 'question', answer: 'y' } }));
    server.on('request_access', async () => ({ status: 'denied', grantId: 'x' }));
    const c = client();
    await c.connect();
    const ask = () => c.call('ask_user', { kind: 'question', payload: {}, waitMs: 0 });
    await ask();
    await ask();
    await ask();
    await expect(ask()).rejects.toMatchObject({ code: ErrorCode.rateLimited, message: /questions/ });
    // The request bucket is untouched by asks: one request_access + one host-metered slot, then exhausted.
    await c.call('request_access', { target: 't', scope: ['read'], reason: 'r' });
    expect(server.allow('s1')).toBe(true);
    expect(server.allow('s1')).toBe(false);
    await expect(
      c.call('request_access', { target: 't', scope: ['read'], reason: 'r' }),
    ).rejects.toMatchObject({ code: ErrorCode.rateLimited });
    now += 61_000;
    expect(server.allow('s1')).toBe(true);
    expect(server.allow('s1', 'ask')).toBe(true);
    c.close();
  });

  it('L3: two hellos racing through authenticate bind once and drop the connection', async () => {
    const slow = new BrokerServer({
      authenticate: async (sid, tok) => {
        await new Promise((r) => setTimeout(r, 30));
        return sid === 's1' && tok === TOKEN ? session : null;
      },
    });
    const p2 = join(mkdtempSync(join(tmpdir(), 'styx-brk-')), 'b.sock');
    await slow.listen(p2);
    const sock = connect(p2);
    await new Promise<void>((r) => sock.once('connect', () => r()));
    const lines: { id: number; error?: { code: number } }[] = [];
    let buf = '';
    sock.on('data', (d) => {
      buf += String(d);
      for (const l of buf.split('\n').slice(0, -1)) lines.push(JSON.parse(l) as (typeof lines)[number]);
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
    });
    const hello = (id: number) =>
      `${JSON.stringify({ jsonrpc: '2.0', id, method: 'hello', params: { v: 1, sessionId: 's1', token: TOKEN, client: 'mcp', pid: 1 } })}\n`;
    sock.write(hello(1) + hello(2));
    await new Promise((r) => setTimeout(r, 150));
    expect(lines.map((l) => [l.id, l.error?.code ?? 'ok'])).toEqual([
      [1, 'ok'],
      [2, ErrorCode.invalidRequest],
    ]);
    expect(slow.connectionCount()).toBe(0);
    sock.destroy();
    await slow.close();
  });

  it.skipIf(process.platform === 'win32')(
    'L2: the socket directory must be ours, 0700 and not a symlink; the socket is born 0600',
    async () => {
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
    },
  );

  it('listen removes a stale socket file but refuses to steal one another broker is still serving', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'styx-broker-'));
    chmodSync(dir, 0o700);
    const p = join(dir, 'broker.sock');
    const first = new BrokerServer({ authenticate: async () => null });
    await first.listen(p);
    // Live: a second instance must not unlink it (that is exactly what killed the running app's shims).
    const second = new BrokerServer({ authenticate: async () => null });
    await expect(second.listen(p)).rejects.toThrow(/another broker is listening/);
    expect(statSync(p).isSocket()).toBe(true);
    await first.close();
    // The file stays behind after a close; now nothing answers, so a new instance may take the path.
    await second.listen(p);
    expect(statSync(p).isSocket()).toBe(true);
    await second.close();
  });
});

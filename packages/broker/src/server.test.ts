import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrokerClient, BrokerClientError } from './client';
import { BrokerServer, BrokerError } from './server';
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

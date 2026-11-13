import { copy, type HubState, type Session } from '@styx/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditInput } from './audit-service';
import { MemoryVault } from './credential-vault';
import { HubError, HubService, type HubDelivery, type HubLane } from './hub-service';

const HUB = 'https://hub.test';

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A scripted hub: records every call and answers from `routes`, keyed `METHOD /path` (query ignored). */
const fakeHub = () => {
  const calls: Call[] = [];
  const routes = new Map<string, (c: Call) => { status?: number; body?: unknown }>();
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const call: Call = {
      method: init?.method ?? 'GET',
      path: u.pathname + u.search,
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    const route = routes.get(`${call.method} ${u.pathname}`);
    if (route === undefined) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    const out = route(call);
    return new Response(out.status === 204 ? null : JSON.stringify(out.body ?? {}), {
      status: out.status ?? 200,
    });
  }) as typeof globalThis.fetch;
  return { calls, routes, fetch };
};

const session = (id: string, over: Partial<Session> = {}): Session =>
  ({
    id,
    projectId: 'prj_local',
    worktreeId: 'wt_1',
    agent: 'claude',
    state: 'working',
    archivedAt: null,
    firstMessage: 'Card form for checkout',
    note: null,
    ...over,
  }) as unknown as Session;

const ME = {
  account: { id: 'usr_nic', email: 'nic@launchsite.co.za', name: 'Nic' },
  teams: [{ id: 'team_ls', name: 'Launchsite', domain: 'launchsite.co.za', role: 'admin' }],
  spaces: [{ id: 'spc_acme', teamId: 'team_ls', name: 'Acme', role: 'owner', agentProposals: 'review' }],
};

const setup = () => {
  const hub = fakeHub();
  const vault = new MemoryVault();
  const store = new Map<string, unknown>();
  const published: HubState[] = [];
  const audits: AuditInput[] = [];
  const delivered: { sessionId: string; meta: HubDelivery; body: string }[] = [];
  const lanes = new Map<string, HubLane>([
    ['ses_1', { session: session('ses_1'), projectId: 'prj_local', branch: 'agent/claude-4' }],
    [
      'ses_2',
      { session: session('ses_2', { agent: 'codex' }), projectId: 'prj_local', branch: 'agent/codex-2' },
    ],
  ]);
  let remote: string | null = 'git@github.com:acme/shop.git';
  let now = 1_000_000;
  hub.routes.set('GET /v1/me', () => ({ body: ME }));
  const service = new HubService({
    fetch: hub.fetch,
    vault,
    store: {
      get: <T>(k: string) => store.get(k) as T | undefined,
      set: (k, v) => void store.set(k, v),
      delete: (k) => void store.delete(k),
    },
    publish: (s) => void published.push(s),
    openExternal: () => undefined,
    now: () => now,
    hubBase: HUB,
    machine: 'Nic MacBook',
    lane: (id) => lanes.get(id) ?? null,
    project: (id) => (id === 'prj_local' ? { name: 'acme-shop', path: '/code/acme-shop' } : null),
    remoteOf: async () => remote,
    deliver: (sessionId, meta, body) => void delivered.push({ sessionId, meta, body }),
    audit: (input) => void audits.push(input),
  });
  return {
    hub,
    vault,
    store,
    published,
    audits,
    delivered,
    lanes,
    service,
    setRemote: (r: string | null) => {
      remote = r;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
};

/** Signed in as if the device flow had finished: tokens in the vault, the row in ui_state, then a refresh. */
const signedIn = async () => {
  const t = setup();
  await t.vault.set('styx:v1:hub:oauth', 'access-1');
  await t.vault.set('styx:v1:hub:refresh', 'refresh-1');
  t.store.set('hub', { ...ME, accessExpiresAt: 1_000_000 + 3_600_000 });
  t.service.load();
  return t;
};

const linked = async () => {
  const t = await signedIn();
  t.hub.routes.set('GET /v1/projects', () => ({ body: { projects: [] } }));
  t.hub.routes.set('POST /v1/spaces/spc_acme/projects', () => ({ body: { project: { id: 'prj_hub' } } }));
  await t.service.linkProject('prj_local', 'spc_acme');
  return t;
};

describe('HubService (ADR-0032)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('signs in with the device flow; tokens go to the keychain, never the stored row', async () => {
    const t = setup();
    t.hub.routes.set('POST /v1/device/code', () => ({
      body: {
        deviceCode: 'dc',
        userCode: 'ABCD-EFGH',
        verificationUri: `${HUB}/activate`,
        interval: 1,
        expiresIn: 900,
      },
    }));
    let approved = false;
    t.hub.routes.set('POST /v1/device/token', () =>
      approved
        ? { body: { accessToken: 'tok-access-7Q', refreshToken: 'tok-refresh-9Z', expiresIn: 3600 } }
        : { status: 400, body: { error: 'authorization_pending' } },
    );
    await t.service.signIn();
    expect(t.service.current().connection).toMatchObject({ kind: 'signing-in', userCode: 'ABCD-EFGH' });
    await vi.advanceTimersByTimeAsync(1000);
    approved = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.service.current().connection).toMatchObject({
      kind: 'signed-in',
      account: { email: 'nic@launchsite.co.za' },
    });
    expect(await t.vault.get('styx:v1:hub:oauth')).toBe('tok-access-7Q');
    expect(JSON.stringify(t.store.get('hub'))).not.toContain('tok-access-7Q');
    expect(JSON.stringify(t.published)).not.toContain('tok-refresh-9Z');
    expect(t.audits.map((a) => a.action)).toEqual(['connected']);
  });

  it('says why when the account is not on a team', async () => {
    const t = setup();
    t.hub.routes.set('POST /v1/device/code', () => ({
      body: {
        deviceCode: 'dc',
        userCode: 'X',
        verificationUri: `${HUB}/activate`,
        interval: 1,
        expiresIn: 900,
      },
    }));
    t.hub.routes.set('POST /v1/device/token', () => ({ status: 400, body: { error: 'access_denied' } }));
    await t.service.signIn();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.service.current().connection).toEqual({ kind: 'signed-out', error: copy.hub.notOnTeam });
  });

  it('signs out on a refused refresh, and only then', async () => {
    const t = await signedIn();
    t.advance(3_600_000);
    t.hub.routes.set('POST /v1/token/refresh', () => ({ status: 500 }));
    await t.service.refresh();
    expect(t.service.current().connection).toMatchObject({
      kind: 'signed-in',
      staleSince: expect.any(Number),
    });
    t.hub.routes.set('POST /v1/token/refresh', () => ({ status: 401 }));
    await t.service.refresh();
    expect(t.service.current().connection.kind).toBe('signed-out');
    expect(await t.vault.get('styx:v1:hub:oauth')).toBeNull();
  });

  it('links a project by its remote, reusing the hub project when the space already has it', async () => {
    const t = await signedIn();
    t.hub.routes.set('GET /v1/projects', () => ({
      body: { projects: [{ id: 'prj_existing', spaceId: 'spc_acme' }] },
    }));
    await t.service.linkProject('prj_local', 'spc_acme');
    expect(t.service.current().links).toEqual([
      { projectId: 'prj_local', spaceId: 'spc_acme', hubProjectId: 'prj_existing' },
    ]);
    expect(t.hub.calls.some((c) => c.method === 'POST')).toBe(false);
    expect(t.hub.calls.find((c) => c.path.startsWith('/v1/projects'))?.path).toContain(
      encodeURIComponent('git@github.com:acme/shop.git'),
    );
  });

  it('refuses to link a project with no remote', async () => {
    const t = await signedIn();
    t.setRemote(null);
    await expect(t.service.linkProject('prj_local', 'spc_acme')).rejects.toThrow(/no git remote/);
  });

  it('shares a lane only when linked, and unsharing deletes it on the hub', async () => {
    const t = await signedIn();
    await expect(t.service.shareLane('ses_1', true)).rejects.toThrow(copy.hub.errors.notLinked);
    const l = await linked();
    l.hub.routes.set('PUT /v1/spaces/spc_acme/lanes/ses_1', () => ({ body: {} }));
    await l.service.shareLane('ses_1', true);
    const put = l.hub.calls.find((c) => c.method === 'PUT');
    expect(put?.body).toMatchObject({
      agent: 'Claude',
      branch: 'agent/claude-4',
      machine: 'Nic MacBook',
      task: 'Card form for checkout',
      projectId: 'prj_hub',
    });
    // The person shares; no lane headers: an agent never shares itself.
    expect(put?.headers['X-Styx-Session']).toBeUndefined();
    expect(l.service.current().shares).toEqual([{ sessionId: 'ses_1', spaceId: 'spc_acme' }]);
    l.hub.routes.set('DELETE /v1/spaces/spc_acme/lanes/ses_1', () => ({ status: 204 }));
    await l.service.shareLane('ses_1', false);
    expect(l.service.current().shares).toEqual([]);
    expect(l.audits.filter((a) => a.triggeredBy.startsWith('hub ')).map((a) => a.action)).toEqual([
      'connected',
      'connected',
      'disconnected',
    ]);
  });

  it('keeps shared lanes current, sending only what changed', async () => {
    const t = await linked();
    t.hub.routes.set('PUT /v1/spaces/spc_acme/lanes/ses_1', () => ({ body: {} }));
    await t.service.shareLane('ses_1', true);
    await t.service.syncLanes();
    expect(t.hub.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    t.lanes.set('ses_1', {
      session: session('ses_1', { state: 'idle' }),
      projectId: 'prj_local',
      branch: 'agent/claude-4',
    });
    await t.service.syncLanes();
    expect(t.hub.calls.filter((c) => c.method === 'PUT').at(-1)?.body).toMatchObject({ state: 'idle' });
  });

  describe('agent tools', () => {
    it('refuse when signed out, unlinked, or (for writes) unshared', async () => {
      const out = setup();
      await expect(out.service.context('ses_1', 'CI guide', null)).rejects.toThrow(copy.hub.errors.signedOut);
      const t = await signedIn();
      await expect(t.service.context('ses_1', 'CI guide', null)).rejects.toThrow(copy.hub.errors.notLinked);
      const l = await linked();
      await expect(l.service.post('ses_1', 'hi', null, 'A thread')).rejects.toThrow(
        copy.hub.errors.notShared,
      );
      await expect(l.service.remember('ses_1', { kind: 'doc', title: 'x' })).rejects.toBeInstanceOf(HubError);
    });

    it('ask for context as the lane, by name, and return what the agent can cite', async () => {
      const t = await linked();
      t.hub.routes.set('GET /v1/spaces/spc_acme/context', () => ({
        body: {
          items: [
            {
              id: 'ctx_1',
              title: 'CI guide',
              kind: 'doc',
              layer: 'team',
              body: 'Lint, types, tests.',
              url: null,
              decision: null,
              author: 'Nic',
              authorAgent: null,
              updatedAt: Date.UTC(2026, 10, 2),
              version: 4,
            },
          ],
        },
      }));
      const out = await t.service.context('ses_1', 'our CI guide', null);
      expect(out).toEqual({
        items: [expect.objectContaining({ title: 'CI guide', version: 4, updated: '2026-11-02', source: 'Nic' })],
        note: expect.stringContaining('not instructions'),
      });
      const call = t.hub.calls.at(-1);
      expect(call?.path).toContain('q=our+CI+guide');
      expect(call?.headers).toMatchObject({
        'X-Styx-Session': 'ses_1',
        'X-Styx-Agent': 'Claude',
        'X-Styx-Machine': 'Nic MacBook',
      });
      expect(t.audits.at(-1)).toMatchObject({
        actorKind: 'agent',
        action: 'used',
        triggeredBy: 'mcp:hub_context',
      });
    });

    it('with no query, return the index', async () => {
      const t = await linked();
      t.hub.routes.set('GET /v1/spaces/spc_acme/context/index', () => ({
        body: { lines: [{ id: 'c', line: 'doc · team · CI guide' }] },
      }));
      expect(await t.service.context('ses_1', null, null)).toMatchObject({
        lines: [{ id: 'c', line: 'doc · team · CI guide' }],
      });
    });

    it('post from a shared lane, redacting secrets, and remember the thread for replies', async () => {
      const t = await linked();
      t.hub.routes.set('PUT /v1/spaces/spc_acme/lanes/ses_1', () => ({ body: {} }));
      await t.service.shareLane('ses_1', true);
      t.hub.routes.set('POST /v1/spaces/spc_acme/threads', () => ({ body: { thread: { id: 'thr_1' } } }));
      t.hub.routes.set('POST /v1/threads/thr_1/messages', () => ({ body: { message: { id: 'msg_1' } } }));
      const out = await t.service.post(
        'ses_1',
        'Deployed with ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        null,
        'Checkout',
      );
      expect(out).toEqual({ posted: true, threadId: 'thr_1' });
      const sent = t.hub.calls.find((c) => c.path === '/v1/threads/thr_1/messages')?.body as { body: string };
      expect(sent.body).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
      expect((t.store.get('hub') as { threads: Record<string, string[]> }).threads).toEqual({
        thr_1: ['ses_1'],
      });
    });
  });

  it('refreshes once when many callers need a token at the same moment', async () => {
    const t = await linked();
    t.advance(3_600_000);
    let refreshes = 0;
    t.hub.routes.set('POST /v1/token/refresh', () => {
      refreshes += 1;
      return { body: { accessToken: 'tok-new', refreshToken: 'tok-ref-2', expiresIn: 3600 } };
    });
    t.hub.routes.set('GET /v1/spaces/spc_acme/context/index', () => ({ body: { lines: [] } }));
    await Promise.all([1, 2, 3, 4].map(() => t.service.context('ses_1', null, null)));
    expect(refreshes).toBe(1);
    expect(t.service.current().connection.kind).toBe('signed-in');
  });

  it("refuses to read a thread outside the lane's space", async () => {
    const t = await linked();
    t.hub.routes.set('GET /v1/threads/thr_other/messages', () => ({
      body: { messages: [{ spaceId: 'spc_other', body: 'x' }] },
    }));
    await expect(t.service.read('ses_1', 'thr_other')).rejects.toThrow('No such thread in this space.');
  });

  it('stops replies reaching a lane once it is unshared', async () => {
    const t = await linked();
    t.hub.routes.set('PUT /v1/spaces/spc_acme/lanes/ses_1', () => ({ body: {} }));
    t.hub.routes.set('POST /v1/threads/thr_1/messages', () => ({ body: { message: { id: 'm' } } }));
    t.hub.routes.set('DELETE /v1/spaces/spc_acme/lanes/ses_1', () => ({ status: 204 }));
    await t.service.shareLane('ses_1', true);
    await t.service.post('ses_1', 'hi', 'thr_1', null);
    await t.service.shareLane('ses_1', false);
    expect((t.store.get('hub') as { threads: Record<string, string[]> }).threads).toEqual({ thr_1: [] });
  });

  describe('inbound', () => {
    const withThread = async () => {
      const t = await linked();
      t.store.set('hub', { ...(t.store.get('hub') as object), threads: { thr_1: ['ses_1', 'ses_2'] } });
      t.service.load();
      return t;
    };
    const message = (lane: { sessionId: string; agent: string; branch: string } | null, userId: string) => ({
      body: {
        message: { threadId: 'thr_1', userId, body: 'Webhook sends order.id as a string now.', lane },
        author: { name: 'Thandi M.', email: 'thandi@launchsite.co.za' },
      },
    });

    it("delivers a teammate's agent's message to every lane here that posted in the thread", async () => {
      const t = await withThread();
      t.hub.routes.set('GET /v1/messages/msg_9', () =>
        message({ sessionId: 'ses_x', agent: 'Codex', branch: 'agent/codex-2' }, 'usr_thandi'),
      );
      await t.service.inbound('spc_acme', 'msg_9');
      expect(t.delivered.map((d) => d.sessionId)).toEqual(['ses_1', 'ses_2']);
      expect(t.delivered[0]?.meta).toEqual({
        from: 'Thandi M.',
        agent: 'Codex',
        branch: 'agent/codex-2',
        space: 'Acme',
        threadId: 'thr_1',
      });
    });

    it('never echoes a lane its own message, nor the person their own words', async () => {
      const t = await withThread();
      t.hub.routes.set('GET /v1/messages/msg_9', () =>
        message({ sessionId: 'ses_1', agent: 'Claude', branch: 'b' }, 'usr_nic'),
      );
      await t.service.inbound('spc_acme', 'msg_9');
      expect(t.delivered.map((d) => d.sessionId)).toEqual(['ses_2']);
      t.delivered.length = 0;
      t.hub.routes.set('GET /v1/messages/msg_9', () => message(null, 'usr_nic'));
      await t.service.inbound('spc_acme', 'msg_9');
      expect(t.delivered).toEqual([]);
    });
  });

  it('drops links and shares for a space the person has left', async () => {
    const t = await linked();
    t.hub.routes.set('GET /v1/me', () => ({ body: { ...ME, spaces: [] } }));
    await t.service.refresh();
    expect(t.service.current().links).toEqual([]);
  });
});

import { randomBytes } from 'node:crypto';
import { BrokerClient, ErrorCode } from '@styx/broker';
import { copy, fixtures, type ConnectedAppTool } from '@styx/core';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test-support';
import { OWN_CLIENT_PORT, OWN_CLIENT_REDIRECT } from '@styx/core';
import { appSecretRef, loopback, type AppConnector, type Loopback } from './connected-apps-service';
import { sha256 } from './session-service';

const { ids } = fixtures;

const TOOLS: ConnectedAppTool[] = [
  { name: 'search', title: 'Search pages', description: 'Find pages', readOnly: true },
  { name: 'create_page', title: 'Create a page', description: 'Adds a page', readOnly: false },
];

/** A fake app: wants a sign-in until the code "good" is traded, then answers its tools. */
function fakeApp() {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  let signedIn = false;
  const connector: AppConnector = {
    async connect(_url, provider: OAuthClientProvider) {
      if (!signedIn) {
        await provider.redirectToAuthorization(new URL('https://auth.example.com/authorize?x=1'));
        throw new UnauthorizedError('sign in');
      }
      return {
        listTools: async () => TOOLS,
        callTool: async (name, args) => {
          calls.push({ name, args });
          return { text: `did ${name}`, isError: false };
        },
        close: async () => undefined,
      };
    },
    async connectCustom() {
      throw new Error('not used here');
    },
    async finishAuth(_url, provider, code) {
      if (code !== 'good') throw new Error('bad code');
      await provider.saveTokens({ access_token: 'at-secret', token_type: 'bearer' });
      signedIn = true;
    },
  };
  const lb: Loopback = {
    redirectUrl: 'http://127.0.0.1:9/callback',
    code: async () => 'good',
    close: () => undefined,
  };
  return { connector, loopback: async () => lb, calls, opened };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

let t: TestApp | null = null;
afterEach(async () => {
  await t?.app.broker.close();
  t = null;
});

async function connected(): Promise<{ t: TestApp; app: ReturnType<typeof fakeApp>; appId: string }> {
  const app = fakeApp();
  t = makeTestApp({
    appConnector: app.connector,
    appLoopback: app.loopback,
    openExternal: async (u) => void app.opened.push(u),
  });
  const r = await t.app.bus.dispatch(t.sender, 'connectedApps.add', {
    name: 'Notion',
    url: 'https://mcp.notion.com/mcp/s/sekret-path-token',
    projectId: ids.project.acmeShop,
  });
  if (!r.ok) throw new Error(r.error.message);
  await settle();
  return { t, app, appId: r.value.appId };
}

async function agent(test: TestApp, sessionId: string): Promise<BrokerClient> {
  const token = randomBytes(32).toString('hex');
  test.app.repos.sessions.setBrokerTokenHash(sessionId, sha256(token));
  await test.app.broker.listen();
  const client = new BrokerClient({
    endpoint: test.app.runtime.brokerEndpoint,
    sessionId,
    token,
    client: 'shim',
  });
  await client.connect();
  return client;
}

describe('ConnectedAppsService (ADR-0033 tier 2)', () => {
  it('signs in on the app’s own page, keeps the sign-in in the keychain only, and lists its tools', async () => {
    const { t: test, app, appId } = await connected();
    expect(app.opened).toEqual(['https://auth.example.com/authorize?x=1']);
    const listed = test.app.connectedApps.current()[0];
    expect(listed).toMatchObject({
      id: appId,
      name: 'Notion',
      url: 'https://mcp.notion.com',
      status: 'connected',
      tools: TOOLS,
      projects: [ids.project.acmeShop],
    });
    expect(await test.vault.get(appSecretRef(appId))).toContain('at-secret');
    // The full address can carry a secret: keychain only.
    expect(await test.vault.get(appSecretRef(appId))).toContain('sekret-path-token');
    expect(JSON.stringify(test.app.publisher.snapshot())).not.toContain('sekret-path-token');
    expect(JSON.stringify(test.app.repos.audit.recent(10))).not.toContain('sekret-path-token');
    // Never in the read model, the stored list or the audit log.
    const snapshot = JSON.stringify(test.app.publisher.snapshot());
    expect(snapshot).not.toContain('at-secret');
    expect(snapshot).toContain('"connectedApps"');
    expect(JSON.stringify(test.app.repos.settings.kv.get('connectedApps'))).not.toContain('at-secret');
    expect(test.app.repos.audit.recent(5).map((r) => r.action)).toContain('connected');
  });

  it('refuses an address that is not https (or this machine)', async () => {
    t = makeTestApp();
    const r = await t.app.bus.dispatch(t.sender, 'connectedApps.add', {
      name: 'X',
      url: 'http://evil.example/mcp',
    });
    expect(r.ok).toBe(false);
    expect(t.app.connectedApps.current()).toEqual([]);
  });

  it('settings.set from a window cannot write the app list', async () => {
    t = makeTestApp();
    await t.app.bus.dispatch(t.sender, 'settings.set', {
      patch: { connectedApps: [{ id: 'x' }] } as unknown as { oneMode: boolean },
    });
    expect(t.app.repos.settings.kv.get('connectedApps')).toBeUndefined();
  });

  it('a failed sign-in shows the error; remove forgets the app and its sign-in', async () => {
    const app = fakeApp();
    t = makeTestApp({
      appConnector: { ...app.connector, finishAuth: async () => Promise.reject(new Error('bad code')) },
      appLoopback: app.loopback,
    });
    const r = await t.app.bus.dispatch(t.sender, 'connectedApps.add', {
      projectId: null,
      name: 'Linear',
      url: 'https://mcp.linear.app/mcp',
    });
    if (!r.ok) throw new Error('add');
    await settle();
    expect(t.app.connectedApps.current()[0]).toMatchObject({ status: 'error', error: 'bad code' });
    await t.vault.set(appSecretRef(r.value.appId), '{}');
    expect(await t.app.bus.dispatch(t.sender, 'connectedApps.remove', { appId: r.value.appId })).toEqual({
      ok: true,
      value: {},
    });
    expect(t.app.connectedApps.current()).toEqual([]);
    expect(await t.vault.get(appSecretRef(r.value.appId))).toBeNull();
    expect(t.app.repos.audit.recent(5).map((x) => x.action)).toContain('disconnected');
  });

  it('agents see connected apps and tools, never an address', async () => {
    const { t: test } = await connected();
    const client = await agent(test, ids.session.gemini);
    const apps = await client.call('list_apps', {});
    expect(apps).toEqual([
      {
        app: test.app.connectedApps.current()[0]?.id,
        name: 'Notion',
        tools: TOOLS.map(({ name, description, readOnly }) => ({ name, description, readOnly })),
      },
    ]);
    expect(JSON.stringify(apps)).not.toContain('mcp.notion.com');
    client.close();
  });

  it('a read-only tool runs at once and goes on the record', async () => {
    const { t: test, app } = await connected();
    const client = await agent(test, ids.session.gemini);
    const r = await client.call('use_app', { app: 'Notion', tool: 'search', arguments: { q: 'brand' } });
    expect(r).toEqual({ text: 'did search', isError: false });
    expect(app.calls).toEqual([{ name: 'search', args: { q: 'brand' } }]);
    const used = test.app.repos.audit.recent(5).find((x) => x.targetLabel === 'Notion · search');
    expect(used).toMatchObject({
      actorKind: 'agent',
      sessionId: ids.session.gemini,
      targetLabel: 'Notion · search',
    });
    client.close();
  });

  it('a change waits for the person: Allow once runs it, Don’t allow refuses it, both on the record', async () => {
    const { t: test, app } = await connected();
    const client = await agent(test, ids.session.gemini);
    const allowed = client.call('use_app', {
      app: 'Notion',
      tool: 'create_page',
      arguments: { title: 'Q4' },
    });
    await settle();
    expect(app.calls).toEqual([]);
    const ask = test.app.repos.pendingAsks
      .openBySession(ids.session.gemini)
      .find((a) => a.kind === 'decision');
    expect(ask?.payload).toMatchObject({
      prompt: expect.stringContaining('wants to use Notion: Create a page'),
      options: [copy.one.apps.allowOnce, copy.one.apps.dontAllow],
    });
    await test.app.bus.dispatch(test.sender, 'ask.respond', {
      askId: ask?.id,
      resolution: { kind: 'decision', chosen: copy.one.apps.allowOnce },
    });
    expect(await allowed).toEqual({ text: 'did create_page', isError: false });
    expect(app.calls).toEqual([{ name: 'create_page', args: { title: 'Q4' } }]);

    const refused = client.call('use_app', {
      app: 'Notion',
      tool: 'create_page',
      arguments: { title: 'Q5' },
    });
    await settle();
    const ask2 = test.app.repos.pendingAsks
      .openBySession(ids.session.gemini)
      .find((a) => a.kind === 'decision');
    await test.app.bus.dispatch(test.sender, 'ask.respond', {
      askId: ask2?.id,
      resolution: { kind: 'decision', chosen: copy.one.apps.dontAllow },
    });
    await expect(refused).rejects.toMatchObject({ code: ErrorCode.notAllowed });
    expect(app.calls).toHaveLength(1);
    expect(test.app.repos.audit.recent(10).map((x) => x.action)).toEqual(
      expect.arrayContaining(['used', 'denied']),
    );
    client.close();
  });

  it('an app is only for the projects it is turned on for', async () => {
    const { t: test, appId } = await connected();
    const blog = await agent(test, ids.session.blog);
    expect(await blog.call('list_apps', {})).toEqual([]);
    await expect(
      blog.call('use_app', { app: 'Notion', tool: 'search', arguments: {} }),
    ).rejects.toMatchObject({
      code: ErrorCode.notAllowed,
    });
    await test.app.bus.dispatch(test.sender, 'connectedApps.setProjects', {
      appId,
      projectIds: [ids.project.blogV2],
    });
    expect(await blog.call('list_apps', {})).toHaveLength(1);
    blog.close();
  });

  it('arguments too long to show the person are refused, never cut', async () => {
    const { t: test, app } = await connected();
    const client = await agent(test, ids.session.gemini);
    await expect(
      client.call('use_app', {
        app: 'Notion',
        tool: 'create_page',
        arguments: { note: 'x'.repeat(2000), to: 'a@b' },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.notAllowed, message: expect.stringContaining('too long') });
    expect(
      test.app.repos.pendingAsks.openBySession(ids.session.gemini).filter((a) => a.kind === 'decision'),
    ).toEqual([]);
    expect(app.calls).toEqual([]);
    client.close();
  });

  it('an unknown app or tool is refused with words the agent can act on', async () => {
    const { t: test } = await connected();
    const client = await agent(test, ids.session.gemini);
    await expect(client.call('use_app', { app: 'Nope', tool: 'x', arguments: {} })).rejects.toMatchObject({
      code: ErrorCode.notAllowed,
      message: expect.stringContaining('list_apps'),
    });
    await expect(
      client.call('use_app', { app: 'Notion', tool: 'drop_all', arguments: {} }),
    ).rejects.toMatchObject({
      code: ErrorCode.notAllowed,
    });
    client.close();
  });
});

describe('Add your own: own OAuth client or a key', () => {
  it('keeps the person’s own client across sign-ins and listens on the fixed return address', async () => {
    const app = fakeApp();
    const ports: number[] = [];
    t = makeTestApp({
      appConnector: app.connector,
      appLoopback: async (port) => {
        ports.push(port);
        return app.loopback();
      },
    });
    const r = await t.app.bus.dispatch(t.sender, 'connectedApps.add', {
      name: 'Slack',
      url: 'https://mcp.slack.com/mcp',
      projectId: ids.project.acmeShop,
      clientId: 'abc.123',
      clientSecret: 's3cret-value',
    });
    if (!r.ok) throw new Error(r.error.message);
    await settle();
    expect(ports).toEqual([OWN_CLIENT_PORT]);
    const kept = await t.vault.get(appSecretRef(r.value.appId));
    expect(kept).toContain('abc.123');
    expect(kept).toContain('s3cret-value');
    expect(kept).toContain(OWN_CLIENT_REDIRECT);
    expect(JSON.stringify(t.app.publisher.snapshot())).not.toContain('s3cret-value');
    expect(t.app.connectedApps.current()[0]?.status).toBe('connected');
  });

  it('sends a key in the header named, a bare token as a bearer token, and never shows it', async () => {
    const seen: Record<string, string>[] = [];
    const app = fakeApp();
    t = makeTestApp({
      appConnector: {
        ...app.connector,
        async connectCustom(target) {
          seen.push(target.headers);
          return {
            listTools: async () => TOOLS,
            callTool: async () => ({ text: '', isError: false }),
            close: async () => undefined,
          };
        },
      },
    });
    const r = await t.app.bus.dispatch(t.sender, 'connectedApps.add', {
      name: 'Ours',
      url: 'https://mcp.example.com/mcp',
      projectId: null,
      token: 'tok-123456',
    });
    if (!r.ok) throw new Error(r.error.message);
    await settle();
    expect(seen).toEqual([{ Authorization: 'Bearer tok-123456' }]);
    expect(t.app.connectedApps.current()[0]).toMatchObject({
      kind: 'custom',
      status: 'connected',
      url: 'https://mcp.example.com',
    });
    expect(JSON.stringify(t.app.publisher.snapshot())).not.toContain('tok-123456');
    const bad = await t.app.bus.dispatch(t.sender, 'connectedApps.add', {
      name: 'X',
      url: 'https://mcp.example.com/mcp',
      projectId: null,
      token: 'k',
      header: 'Bad Header!',
    });
    expect(bad.ok).toBe(false);
  });
});

describe('own-client and key safety', () => {
  it.each([
    ['mcp.slack.com', 'slack.com'],
    ['api.hubapi.com', 'hubapi.com'],
    ['a.b.example.co.za', 'example.co.za'],
    ['login.example.co.uk', 'example.co.uk'],
  ])('siteOf(%s) → %s', async (host, site) => {
    const { siteOf } = await import('./connected-apps-service');
    expect(siteOf(host)).toBe(site);
  });

  it('refuses a key a header cannot carry, a reserved header, and a client ID with a key', async () => {
    t = makeTestApp();
    const add = (extra: Record<string, string>) =>
      t?.app.bus.dispatch(t.sender, 'connectedApps.add', {
        name: 'X',
        url: 'https://mcp.example.com/mcp',
        projectId: null,
        ...extra,
      });
    expect((await add({ token: 'abc\u0000def' }))?.ok).toBe(false);
    expect((await add({ token: 'abc', header: 'Host' }))?.ok).toBe(false);
    expect((await add({ token: 'abc', clientId: 'id' }))?.ok).toBe(false);
    expect((await add({ clientId: 'id', issuer: 'http://login.example.com' }))?.ok).toBe(false);
    expect(t.app.connectedApps.current()).toEqual([]);
  });

  it('says so when the fixed sign-in port is busy, instead of hanging', async () => {
    t = makeTestApp({
      appLoopback: async () => {
        throw new Error('EADDRINUSE');
      },
    });
    const r = await t.app.bus.dispatch(t.sender, 'connectedApps.add', {
      name: 'Slack',
      url: 'https://mcp.slack.com/mcp',
      projectId: null,
      clientId: 'abc',
    });
    if (!r.ok) throw new Error(r.error.message);
    await settle();
    expect(t.app.connectedApps.current()[0]).toMatchObject({
      status: 'error',
      error: expect.stringContaining('33418'),
    });
  });
});

describe('loopback', () => {
  it('takes the code only with the state Styx sent', async () => {
    const lb = await loopback();
    const got = lb.code('s1');
    const wrong = await fetch(`${lb.redirectUrl}?code=c&state=nope`);
    expect(wrong.status).toBe(400);
    const right = await fetch(`${lb.redirectUrl}?code=c1&state=s1`);
    expect(right.status).toBe(200);
    expect(await got).toBe('c1');
    lb.close();
  });
});

describe('sdkConnector against a real MCP server', () => {
  it('lists tools with their read-only flag and calls one', async () => {
    const { createServer } = await import('node:http');
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { StreamableHTTPServerTransport } =
      await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const { z } = await import('zod');
    const http = createServer((req, res) => {
      // Stateless: a fresh server per request, as the SDK's own example does.
      const mcp = new McpServer({ name: 'fake', version: '1' });
      mcp.registerTool(
        'search',
        { description: 'Find', inputSchema: { q: z.string() }, annotations: { readOnlyHint: true } },
        async ({ q }) => ({ content: [{ type: 'text', text: `found ${q}` }] }),
      );
      mcp.registerTool('create', { description: 'Make' }, async () => ({
        content: [{ type: 'text', text: 'made' }],
      }));
      const transport = new StreamableHTTPServerTransport({});
      res.on('close', () => void transport.close());
      void mcp.connect(transport as never).then(() => transport.handleRequest(req, res));
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    const port = (http.address() as { port: number }).port;
    const { sdkConnector } = await import('./connected-apps-service');
    const provider = {
      redirectUrl: 'http://127.0.0.1:1/callback',
      clientMetadata: { redirect_uris: ['http://127.0.0.1:1/callback'] },
      clientInformation: () => undefined,
      tokens: () => undefined,
      saveTokens: () => undefined,
      redirectToAuthorization: () => undefined,
      saveCodeVerifier: () => undefined,
      codeVerifier: () => '',
    } satisfies OAuthClientProvider;
    const conn = await sdkConnector.connect(new URL(`http://127.0.0.1:${port}/mcp`), provider);
    expect(await conn.listTools()).toEqual([
      { name: 'search', title: null, description: 'Find', readOnly: true },
      { name: 'create', title: null, description: 'Make', readOnly: false },
    ]);
    expect(await conn.callTool('search', { q: 'brand' })).toEqual({ text: 'found brand', isError: false });
    await conn.close();
    http.close();
  });
});

describe('appMayReach', () => {
  const remote = new URL('https://mcp.notion.com/mcp');
  const local = new URL('http://127.0.0.1:3000/mcp');
  it.each([
    [remote, 'https://auth.notion.com/authorize', true],
    [remote, 'https://login.example.com/x', true],
    [remote, 'http://auth.notion.com/authorize', false],
    [remote, 'https://169.254.169.254/latest', false],
    [remote, 'https://10.0.0.5/token', false],
    [remote, 'https://192.168.1.1/', false],
    [remote, 'https://127.0.0.1:8080/', false],
    [remote, 'http://127.0.0.1:8080/', false],
    [remote, 'https://user:pw@auth.notion.com/', false],
    [remote, 'javascript:alert(1)', false],
    [local, 'http://127.0.0.1:3000/authorize', true],
    [local, 'http://localhost:3000/authorize', true],
    [local, 'http://evil.example/authorize', false],
  ])('%s → %s: %s', async (app, to, ok) => {
    const { appMayReach } = await import('./connected-apps-service');
    expect(appMayReach(app, new URL(to))).toBe(ok);
  });
});

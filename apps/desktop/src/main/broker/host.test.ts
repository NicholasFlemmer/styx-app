import { randomBytes } from 'node:crypto';
import { BrokerClient, ErrorCode } from '@styx/broker';
import { fixtures } from '@styx/core';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from '../services/session-service';
import { makeTestApp, type TestApp } from '../test-support';

const { ids } = fixtures;

let t: TestApp | null = null;
afterEach(async () => {
  await t?.app.broker.close();
  t = null;
});

async function connectedClient(sessionId: string): Promise<{ t: TestApp; client: BrokerClient }> {
  t = makeTestApp();
  const token = randomBytes(32).toString('hex');
  t.app.repos.sessions.setBrokerTokenHash(sessionId, sha256(token));
  await t.app.broker.listen();
  const client = new BrokerClient({
    endpoint: t.app.runtime.brokerEndpoint,
    sessionId,
    token,
    client: 'shim',
  });
  const brief = await client.connect();
  expect(brief).toMatchObject({ sessionId, projectId: ids.project.acmeShop, projectName: 'acme-shop' });
  return { t, client };
}

describe('BrokerHost', () => {
  it('rejects a wrong token', async () => {
    t = makeTestApp();
    t.app.repos.sessions.setBrokerTokenHash(ids.session.gemini, sha256('right'));
    await t.app.broker.listen();
    const client = new BrokerClient({
      endpoint: t.app.runtime.brokerEndpoint,
      sessionId: ids.session.gemini,
      token: 'wrong-token-wrong-token',
      client: 'cli',
    });
    await expect(client.connect()).rejects.toThrow(/unauthenticated/);
  });

  it('exec_authorize returns the Vercel env from the adapter (MemoryVault) under the preview target policy, records a use and audits it', async () => {
    const { t: app, client } = await connectedClient(ids.session.gemini);
    const target = app.app.repos.targets.get(ids.target.vercelPreview);
    if (!target?.credentialRef) throw new Error('fixture');
    await app.vault.set(target.credentialRef, JSON.stringify({ token: 'vt-preview' }));
    const r = await client.call('exec_authorize', {
      tool: 'vercel',
      argv: ['env', 'add', 'FOO'],
      cwd: '/tmp',
    });
    expect(r.env).toEqual({ VERCEL_TOKEN: 'vt-preview' });
    const grant = app.app.repos.grants.get(r.grantId);
    expect(grant).toMatchObject({
      state: 'active',
      targetId: ids.target.vercelPreview,
      scope: ['write'],
      decidedBy: 'target-policy',
      reason: '$ vercel env add FOO',
    });
    expect(app.app.repos.grantUses.get(r.useId)).toMatchObject({
      via: 'shim',
      scopeUsed: 'write',
      exitCode: null,
    });
    await client.call('exec_report', { useId: r.useId, exitCode: 0 });
    expect(app.app.repos.grantUses.get(r.useId)?.exitCode).toBe(0);
    const used = app.app.repos.audit.all().find((e) => e.grantId === r.grantId && e.action === 'used');
    expect(used).toMatchObject({
      actorKind: 'agent',
      triggeredBy: '$ vercel env add FOO',
      targetLabel: 'vercel-preview',
    });
    const targets = await client.call('list_targets', {});
    expect(targets.find((x) => x.name === 'Vercel' && x.env === 'preview')).toMatchObject({
      lockState: 'persistent',
    });
    client.close();
  });

  it('request_access holds the reply until the user approves, then get_credential returns the bundle', async () => {
    const { t: app, client } = await connectedClient(ids.session.gemini);
    const target = app.app.repos.targets.get(ids.target.supabaseProd);
    if (!target?.credentialRef) throw new Error('fixture');
    await app.vault.set(target.credentialRef, JSON.stringify({ token: 'sbp' }));
    const pending = client.call('request_access', {
      target: 'supabase-prod',
      scope: ['read', 'write'],
      reason: 'migration 0042',
    });
    await new Promise((r) => setTimeout(r, 50));
    const grant = app.app.repos.grants.bySession(ids.session.gemini).find((g) => g.state === 'requested');
    expect(grant).toBeDefined();
    expect(app.app.broker.server.heldKeys().some((k) => k.startsWith(`grant:${grant?.id}:`))).toBe(true);
    await app.app.grants.approve(grant?.id ?? '', '1h');
    const out = await pending;
    expect(out).toMatchObject({
      status: 'active',
      grantId: grant?.id,
      scope: ['read', 'write'],
      decidedBy: 'user',
    });
    const cred = await client.call('get_credential', { grantId: grant?.id ?? '' });
    expect(cred).toMatchObject({ kind: 'env', env: { SUPABASE_ACCESS_TOKEN: 'sbp' }, scoped: false });
    expect(
      app.app.repos.audit.all().filter((e) => e.grantId === grant?.id && e.action === 'used'),
    ).toHaveLength(1);
    client.close();
  });

  it('request_access resolves denied when the user denies', async () => {
    const { t: app, client } = await connectedClient(ids.session.gemini);
    const pending = client.call('request_access', {
      target: 'AWS acme-prod',
      scope: ['read'],
      reason: 'list ECS services',
    });
    await new Promise((r) => setTimeout(r, 50));
    const grant = app.app.repos.grants
      .bySession(ids.session.gemini)
      .find((g) => g.state === 'requested' && g.targetId === ids.target.awsProd);
    app.app.grants.deny(grant?.id ?? '');
    expect(await pending).toEqual({ status: 'denied', grantId: grant?.id });
    client.close();
  });

  it('ask_user opens a decision ask and returns the chosen option after ask.respond', async () => {
    const { t: app, client } = await connectedClient(ids.session.gemini);
    const pending = client.call('ask_user', {
      kind: 'decision',
      payload: { prompt: 'Open a PR?', options: ['Yes', 'No'] },
    });
    await new Promise((r) => setTimeout(r, 50));
    const ask = app.app.repos.pendingAsks.openBySession(ids.session.gemini)[0];
    expect(ask).toMatchObject({ kind: 'decision', payload: { prompt: 'Open a PR?' } });
    expect(app.app.repos.sessions.get(ids.session.gemini)?.state).toBe('needs-you');
    const r = await app.app.bus.dispatch(app.sender, 'ask.respond', {
      askId: ask?.id,
      resolution: { kind: 'decision', chosen: 'Yes' },
    });
    expect(r).toEqual({ ok: true, value: {} });
    expect(await pending).toEqual({ resolution: { kind: 'decision', answer: 'Yes' } });
    expect(app.app.repos.sessions.get(ids.session.gemini)?.state).toBe('working');
    client.close();
  });
});

/** A second connection for another session on the same broker (`t` must already be listening). */
async function secondClient(app: TestApp, sessionId: string): Promise<BrokerClient> {
  const token = randomBytes(32).toString('hex');
  app.app.repos.sessions.setBrokerTokenHash(sessionId, sha256(token));
  const client = new BrokerClient({ endpoint: app.app.runtime.brokerEndpoint, sessionId, token, client: 'shim' });
  await client.connect();
  return client;
}

describe('BrokerHost security regressions', () => {
  it('M1: shim argv and agent reasons are redacted before anything is persisted', async () => {
    const { t: app, client } = await connectedClient(ids.session.gemini);
    const preview = app.app.repos.targets.get(ids.target.vercelPreview);
    const prod = app.app.repos.targets.get(ids.target.supabaseProd);
    if (!preview?.credentialRef || !prod?.credentialRef) throw new Error('fixture');
    await app.vault.set(preview.credentialRef, JSON.stringify({ token: 'vt-preview' }));
    const ghp = `ghp_${'c'.repeat(36)}`;
    const r = await client.call('exec_authorize', {
      tool: 'vercel',
      argv: ['--token', 'secretvalue123', 'env', 'add', 'X', '--password=hunter2', ghp],
      cwd: '/tmp',
    });
    expect(r.env).toEqual({ VERCEL_TOKEN: 'vt-preview' }); // the real credential still flows to the shim
    await client.call('exec_report', { useId: r.useId, exitCode: 0 });
    const pending = client
      .call('request_access', { target: 'supabase-prod', scope: ['read'], reason: `migrate with ${ghp}`, triggeredBy: `$ supabase --token ${ghp} db push` })
      .catch(() => undefined);
    await new Promise((res) => setTimeout(res, 50));
    const requested = app.app.repos.grants.bySession(ids.session.gemini).find((g) => g.state === 'requested');
    expect(requested).toBeDefined();
    const dump = JSON.stringify({
      grants: app.app.repos.grants.all(),
      uses: [...app.app.repos.grantUses.byGrant(r.grantId), ...app.app.repos.grantUses.byGrant(requested?.id ?? '')],
      audit: app.app.repos.audit.all(),
      transcript: app.app.repos.transcripts.last(ids.session.gemini),
      asks: app.app.repos.pendingAsks.openBySession(ids.session.gemini),
      session: app.app.repos.sessions.get(ids.session.gemini),
    });
    expect(dump).not.toContain('secretvalue123');
    expect(dump).not.toContain('hunter2');
    expect(dump).not.toContain(ghp);
    expect(app.app.repos.grants.get(r.grantId)?.reason).toBe('$ vercel --token [redacted] env add X --password=[redacted] [redacted]');
    expect(requested?.reason).toBe('migrate with [redacted]');
    app.app.grants.deny(requested?.id ?? '');
    await pending;
    client.close();
  });

  it('M1: report_status notes and ask_user prompts are redacted before they are stored', async () => {
    const { t: app, client } = await connectedClient(ids.session.gemini);
    const ghp = `ghp_${'g'.repeat(36)}`;
    await client.call('report_status', { note: `pushing with ${ghp}` });
    expect(app.app.repos.sessions.get(ids.session.gemini)?.note).toBe('pushing with [redacted]');
    const pending = client.call('ask_user', { kind: 'decision', payload: { prompt: `Use ${ghp}?`, options: ['Yes', `No ${ghp}`] }, waitMs: 1000 }).catch(() => undefined);
    await new Promise((res) => setTimeout(res, 50));
    const ask = app.app.repos.pendingAsks.openBySession(ids.session.gemini).find((a) => a.kind === 'decision');
    expect(JSON.stringify(ask)).not.toContain(ghp);
    expect(ask?.payload).toMatchObject({ prompt: 'Use [redacted]?', options: ['Yes', 'No [redacted]'] });
    await pending;
    client.close();
  });

  it('M3: a session in another project cannot see or fetch a persistent grant', async () => {
    const { t: app, client } = await connectedClient(ids.session.gemini);
    const preview = app.app.repos.targets.get(ids.target.vercelPreview);
    if (!preview?.credentialRef) throw new Error('fixture');
    await app.vault.set(preview.credentialRef, JSON.stringify({ token: 'vt-preview' }));
    // Control: the persistent preview grant is visible from its own project.
    await expect(client.call('get_credential', { grantId: ids.grant.vercelPreviewAlways })).resolves.toMatchObject({ env: { VERCEL_TOKEN: 'vt-preview' } });
    const blog = await secondClient(app, ids.session.blog);
    expect(app.app.repos.sessions.get(ids.session.blog)?.projectId).toBe(ids.project.blogV2);
    await expect(blog.call('get_credential', { grantId: ids.grant.vercelPreviewAlways })).rejects.toMatchObject({ code: ErrorCode.targetNotFound });
    await expect(blog.call('check_grant', { grantId: ids.grant.vercelPreviewAlways, waitMs: 0 })).rejects.toMatchObject({ code: ErrorCode.targetNotFound });
    await expect(
      app.app.grants.credentialFor(ids.grant.vercelPreviewAlways, { sessionId: ids.session.blog, projectId: ids.project.blogV2 }),
    ).rejects.toThrow(/another project/);
    expect(app.app.repos.grantUses.byGrant(ids.grant.vercelPreviewAlways).filter((u) => u.sessionId === ids.session.blog)).toEqual([]);
    blog.close();
    client.close();
  });

  it('L7: exec_report is rejected for a use row opened by another session', async () => {
    const { t: app, client } = await connectedClient(ids.session.gemini);
    const preview = app.app.repos.targets.get(ids.target.vercelPreview);
    if (!preview?.credentialRef) throw new Error('fixture');
    await app.vault.set(preview.credentialRef, JSON.stringify({ token: 'vt-preview' }));
    const r = await client.call('exec_authorize', { tool: 'vercel', argv: ['env', 'ls'], cwd: '/tmp' });
    const blog = await secondClient(app, ids.session.blog);
    await expect(blog.call('exec_report', { useId: r.useId, exitCode: 0 })).rejects.toMatchObject({ code: ErrorCode.targetNotFound });
    expect(app.app.repos.grantUses.get(r.useId)?.exitCode).toBeNull();
    await client.call('exec_report', { useId: r.useId, exitCode: 3 });
    expect(app.app.repos.grantUses.get(r.useId)?.exitCode).toBe(3);
    blog.close();
    client.close();
  });

  it('L1: exec_authorize shares the request bucket only when it opens a new grant request', async () => {
    const { t: app, client } = await connectedClient(ids.session.gemini);
    const preview = app.app.repos.targets.get(ids.target.vercelPreview);
    if (!preview?.credentialRef) throw new Error('fixture');
    await app.vault.set(preview.credentialRef, JSON.stringify({ token: 'vt-preview' }));
    // Covered shim execs are not metered.
    for (let i = 0; i < 7; i += 1) await client.call('exec_authorize', { tool: 'vercel', argv: ['env', 'ls'], cwd: '/tmp' });
    // Requests that need the user are: the 6th within a minute is refused.
    const held = Array.from({ length: 5 }, (_, i) =>
      client.call('exec_authorize', { tool: 'supabase', argv: ['db', 'push', `--n=${i}`], cwd: '/tmp' }, { timeoutMs: 5_000 }).catch(() => undefined),
    );
    await new Promise((res) => setTimeout(res, 50));
    await expect(client.call('exec_authorize', { tool: 'supabase', argv: ['db', 'push'], cwd: '/tmp' })).rejects.toMatchObject({ code: ErrorCode.rateLimited });
    // Duplicate asks collapsed onto one requested grant + one open ask (GrantService dedupe).
    const requested = app.app.repos.grants.bySession(ids.session.gemini).filter((g) => g.state === 'requested' && g.targetId === ids.target.supabaseProd);
    expect(requested).toHaveLength(1);
    expect(app.app.repos.pendingAsks.openBySession(ids.session.gemini).filter((a) => a.grantId === requested[0]?.id)).toHaveLength(1);
    app.app.grants.deny(requested[0]?.id ?? '');
    await Promise.all(held);
    client.close();
  });

  it('L-c: exec_authorize refuses expired or unconnected targets before opening a request, like request_access', async () => {
    const { t: app, client } = await connectedClient(ids.session.gemini);
    const prod = app.app.repos.targets.get(ids.target.supabaseProd);
    if (!prod?.credentialRef) throw new Error('fixture');
    const before = app.app.repos.grants.all().length;
    app.app.repos.targets.upsert({ ...prod, health: 'expired', expiredAt: app.clock.now() });
    await expect(client.call('exec_authorize', { tool: 'supabase', argv: ['db', 'push'], cwd: '/tmp' })).rejects.toMatchObject({
      code: ErrorCode.notAllowed,
      message: expect.stringContaining('expired'),
    });
    await expect(client.call('request_access', { target: 'supabase-prod', scope: ['read'], reason: 'r', waitMs: 0 })).rejects.toMatchObject({
      code: ErrorCode.notAllowed,
    });
    app.app.repos.targets.upsert({ ...prod, credentialRef: null, health: 'unconnected' });
    await expect(client.call('exec_authorize', { tool: 'supabase', argv: ['db', 'push'], cwd: '/tmp' })).rejects.toMatchObject({
      code: ErrorCode.notAllowed,
      message: expect.stringContaining('not connected'),
    });
    await expect(client.call('request_access', { target: 'supabase-prod', scope: ['read'], reason: 'r', waitMs: 0 })).rejects.toMatchObject({
      code: ErrorCode.notAllowed,
    });
    expect(app.app.repos.grants.all().length).toBe(before); // no grant row was opened
    client.close();
  });

  it('held exec requests resolved as `always` grants attribute the use to the holding session', async () => {
    const { t: app, client } = await connectedClient(ids.session.gemini);
    const prod = app.app.repos.targets.get(ids.target.supabaseProd);
    if (!prod?.credentialRef) throw new Error('fixture');
    await app.vault.set(prod.credentialRef, JSON.stringify({ token: 'sbp-prod' }));
    const pending = client.call('exec_authorize', { tool: 'supabase', argv: ['db', 'push'], cwd: '/tmp' }, { timeoutMs: 5_000 });
    await new Promise((res) => setTimeout(res, 50));
    const grant = app.app.repos.grants.bySession(ids.session.gemini).find((g) => g.state === 'requested' && g.targetId === ids.target.supabaseProd);
    if (!grant) throw new Error('expected a requested grant');
    const issued = await app.app.grants.approve(grant.id, 'always');
    expect(issued.sessionId).toBeNull(); // detached persistent grant
    const r = await pending;
    expect(r.env).toEqual({ SUPABASE_ACCESS_TOKEN: 'sbp-prod' });
    expect(app.app.repos.grantUses.get(r.useId)).toMatchObject({ sessionId: ids.session.gemini, via: 'shim', scopeUsed: 'write' });
    client.close();
  });
});

describe('BrokerHost agent-to-agent messaging', () => {
  it('lists only this project\'s sessions, flagging the caller', async () => {
    const { t: app, client } = await connectedClient(ids.session.gemini);
    const peers = await client.call('list_sessions', {});
    const projectIds = new Set(
      peers.map((p) => app.app.repos.sessions.get(p.sessionId)?.projectId),
    );
    expect(projectIds).toEqual(new Set([ids.project.acmeShop]));
    expect(peers.filter((p) => p.self).map((p) => p.sessionId)).toEqual([ids.session.gemini]);
    expect(peers.length).toBeGreaterThan(1);
  });

  it('delivers to a peer as a `peer` row in both chats, never as a user message', async () => {
    const { t: app, client } = await connectedClient(ids.session.gemini);
    await client.call('send_message', { to: ids.session.claude, body: 'checkout.ts is mine right now' });

    const inbox = app.app.repos.transcripts.last(ids.session.claude).at(-1);
    expect(inbox?.payload).toMatchObject({
      kind: 'peer',
      fromSessionId: ids.session.gemini,
      inbound: true,
    });
    expect(inbox?.body).toBe('checkout.ts is mine right now');
    // A `user` row would render as if the operator typed it — the whole point of the separate kind.
    expect(inbox?.payload.kind).not.toBe('user');

    const outbox = app.app.repos.transcripts.last(ids.session.gemini).at(-1);
    expect(outbox?.payload).toMatchObject({ kind: 'peer', inbound: false });
  });

  it('refuses a session in another project — the one guard that keeps this from being cross-project reach', async () => {
    const { t: app, client } = await connectedClient(ids.session.gemini);
    const blog = app.app.repos.sessions.get(ids.session.blog);
    expect(blog?.projectId).not.toBe(ids.project.acmeShop);
    await expect(
      client.call('send_message', { to: ids.session.blog, body: 'hello from another project' }),
    ).rejects.toThrow();
    expect(app.app.repos.transcripts.last(ids.session.blog).at(-1)?.payload.kind).not.toBe('peer');
  });

  it('refuses an unknown session, itself, and a finished one rather than silently swallowing', async () => {
    const { t: app, client } = await connectedClient(ids.session.gemini);
    await expect(client.call('send_message', { to: 'nope', body: 'x' })).rejects.toThrow();
    await expect(
      client.call('send_message', { to: ids.session.gemini, body: 'x' }),
    ).rejects.toThrow(/yourself/);
    const claude = app.app.repos.sessions.get(ids.session.claude);
    if (claude) app.app.repos.sessions.upsert({ ...claude, state: 'done', endedAt: 1, pausedReason: null });
    await expect(
      client.call('send_message', { to: ids.session.claude, body: 'x' }),
    ).rejects.toThrow(/ended/);
  });

  it('is rate limited in its own bucket, so two agents cannot flood each other', async () => {
    const { client } = await connectedClient(ids.session.gemini);
    let refused = 0;
    for (let i = 0; i < 25; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await client.call('send_message', { to: ids.session.claude, body: `m${i}` }).catch(() => {
        refused += 1;
      });
    }
    expect(refused).toBeGreaterThan(0);
  });
});

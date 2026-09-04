import { randomBytes } from 'node:crypto';
import { BrokerClient } from '@styx/broker';
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

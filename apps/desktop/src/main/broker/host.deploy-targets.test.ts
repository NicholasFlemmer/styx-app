import { randomBytes } from 'node:crypto';
import { BrokerClient } from '@styx/broker';
import { fixtures, idFrom, type Target, type TargetId } from '@styx/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeCliRunner } from '../providers/cli-runner';
import { sha256 } from '../services/session-service';
import { makeTestApp, type TestApp } from '../test-support';

const { ids } = fixtures;
const SESSION = ids.session.gemini; // an acme-shop session
const ENV_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.app.broker.close();
  t = null;
});

/** Fake provider edges: flyctl for Fly.io, backboard for Railway, api.render.com for Render. Never the network. */
const fakeCli = () =>
  new FakeCliRunner()
    .install('fly')
    .on('fly', ['apps', 'list', '--json'], {
      stdout: JSON.stringify([{ Name: 'acme-web', Organization: { Slug: 'acme' } }]),
    })
    .on('fly', ['tokens', 'create'], { stdout: JSON.stringify({ token: 'FIXTURE-fly-minted' }) })
    .on('fly', ['tokens', 'revoke', 'supplied'], {});
const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
  if (u.startsWith('https://api.render.com/v1/services'))
    return json([{ service: { id: 'srv-web123', name: 'acme-web' } }]);
  if (u.startsWith('https://backboard.railway.com/graphql/v2')) {
    const q = String(init?.body);
    if (q.includes('environment(id'))
      return json({ data: { environment: { id: ENV_ID, name: 'production', projectId: PROJECT_ID } } });
    if (q.includes('projectTokenCreate'))
      return json({ data: { projectTokenCreate: 'FIXTURE-railway-project' } });
    if (q.includes('projectTokens(')) return json({ data: { projectTokens: { edges: [] } } });
  }
  return new Response('not faked', { status: 404 });
}) as unknown as typeof fetch;

const CASES = [
  {
    provider: 'fly',
    tool: 'fly',
    argv: ['deploy', '--app', 'acme-web'],
    config: { app: 'acme-web' },
    env: { FLY_API_TOKEN: 'FIXTURE-fly-minted', FLY_APP: 'acme-web' },
  },
  {
    provider: 'railway',
    tool: 'railway',
    argv: ['up', '--ci'],
    config: { environmentId: ENV_ID },
    env: { RAILWAY_TOKEN: 'FIXTURE-railway-project' },
  },
  {
    provider: 'render',
    tool: 'render',
    argv: ['deploys', 'create', 'srv-web123', '--confirm'],
    config: { serviceId: 'srv-web123' },
    env: { RENDER_API_KEY: 'FIXTURE-render-key', RENDER_OUTPUT: 'text' },
  },
] as const;

/** acme-shop gains a connected prod target for `provider`, on the loosest policy there is (`always`). */
async function prodTarget(app: TestApp, c: (typeof CASES)[number]): Promise<Target> {
  const base = app.app.repos.targets.get(ids.target.supabaseProd);
  if (!base) throw new Error('fixture');
  const id: TargetId = idFrom<'TargetId'>(`tgt_${c.provider}_prod`);
  const target: Target = {
    ...base,
    id,
    provider: c.provider,
    name: c.provider,
    env: 'prod',
    policy: 'always',
    config: { ...c.config },
    credentialRef: `styx:v1:${c.provider}:${id}:oauth`,
  };
  app.app.repos.targets.upsert(target);
  await app.vault.set(
    target.credentialRef ?? '',
    JSON.stringify({ token: c.provider === 'render' ? 'FIXTURE-render-key' : `FIXTURE-${c.provider}-login` }),
  );
  return target;
}

async function connect(app: TestApp): Promise<BrokerClient> {
  const token = randomBytes(32).toString('hex');
  app.app.repos.sessions.setBrokerTokenHash(SESSION, sha256(token));
  await app.app.broker.listen();
  const client = new BrokerClient({
    endpoint: app.app.runtime.brokerEndpoint,
    sessionId: SESSION,
    token,
    client: 'shim',
  });
  await client.connect();
  return client;
}

describe('BrokerHost: a production deploy on Fly.io, Railway or Render asks with OS authentication', () => {
  it.each(CASES)(
    '$provider: `$tool $argv` is a deploy request even under an `always` policy, and fails without MFA',
    async (c) => {
      t = makeTestApp({ mfa: 'failed', cli: fakeCli(), fetch: fakeFetch });
      const app = t;
      const target = await prodTarget(app, c);
      const client = await connect(app);
      const held = client
        .call('exec_authorize', { tool: c.tool, argv: [...c.argv], cwd: '/tmp' })
        .catch((e: Error) => e);
      const requested = () =>
        app.app.repos.grants.all().filter((g) => g.targetId === target.id && g.state === 'requested');
      await vi.waitFor(() => expect(requested()).toHaveLength(1));
      const grant = requested()[0];
      if (!grant) throw new Error('no request');
      expect(grant.scope).toEqual(['deploy']); // classified as a deploy, never auto-issued
      await expect(app.app.grants.approve(grant.id, '1h')).rejects.toMatchObject({ code: 'mfa-failed' });
      expect(app.app.repos.grants.get(grant.id)?.state).toBe('requested');
      expect(app.app.repos.audit.all().some((e) => e.grantId === grant.id && e.action === 'requested')).toBe(
        true,
      );
      app.app.grants.deny(grant.id);
      await held;
      client.close();
    },
  );

  it.each(CASES)(
    '$provider: approved with MFA, the shim gets the minted or stored env and the use is audited',
    async (c) => {
      t = makeTestApp({ mfa: 'ok', cli: fakeCli(), fetch: fakeFetch });
      const app = t;
      const target = await prodTarget(app, c);
      const client = await connect(app);
      const held = client.call('exec_authorize', { tool: c.tool, argv: [...c.argv], cwd: '/tmp' });
      const requested = () =>
        app.app.repos.grants.all().filter((g) => g.targetId === target.id && g.state === 'requested');
      await vi.waitFor(() => expect(requested()).toHaveLength(1));
      const grant = requested()[0];
      if (!grant) throw new Error('no request');
      expect(await app.app.grants.approve(grant.id, '1h')).toMatchObject({
        state: 'active',
        mfaVerified: true,
      });
      const r = await held;
      expect(r.env).toEqual(c.env);
      const audit = app.app.repos.audit.all().filter((e) => e.grantId === grant.id);
      expect(audit.map((e) => e.action)).toEqual(expect.arrayContaining(['requested', 'granted', 'used']));
      // The stored login never reaches the shim, and nothing secret is in the audit trail.
      expect(JSON.stringify(r.env)).not.toContain('-login');
      expect(JSON.stringify(audit)).not.toMatch(/FIXTURE-(fly|railway|render)/);
      client.close();
    },
  );
});

describe('BrokerHost: a Fly.io command naming an app goes to the target for that app', () => {
  it('`fly deploy --app acme-staging` asks for the staging target, not production; an unnamed one asks for prod', async () => {
    t = makeTestApp({ mfa: 'ok', cli: fakeCli(), fetch: fakeFetch });
    const app = t;
    const prod = await prodTarget(app, CASES[0]);
    const staging: Target = {
      ...prod,
      id: idFrom<'TargetId'>('tgt_fly_staging'),
      name: 'fly staging',
      env: 'staging',
      policy: 'ask',
      config: { app: 'acme-staging' },
      credentialRef: 'styx:v1:fly:tgt_fly_staging:oauth',
    };
    app.app.repos.targets.upsert(staging);
    await app.vault.set(staging.credentialRef ?? '', JSON.stringify({ token: 'FIXTURE-fly-login' }));
    const client = await connect(app);
    const requested = () =>
      app.app.repos.grants
        .all()
        .filter((g) => g.state === 'requested' && (g.targetId === staging.id || g.targetId === prod.id))
        .map((g) => g.targetId);
    void client
      .call('exec_authorize', { tool: 'fly', argv: ['deploy', '--app', 'acme-staging'], cwd: '/tmp' })
      .catch(() => undefined);
    await vi.waitFor(() => expect(requested()).toEqual([staging.id]));
    void client.call('exec_authorize', { tool: 'fly', argv: ['deploy'], cwd: '/tmp' }).catch(() => undefined);
    await vi.waitFor(() => expect(new Set(requested())).toEqual(new Set([staging.id, prod.id])));
    // Only flyctl's own app flag counts, and only for non-read commands: a read naming staging (whose token is
    // org-wide read-only) and a bare `acme-staging` word elsewhere both stay with production.
    for (const g of app.app.repos.grants.all())
      if (g.state === 'requested' && (g.targetId === staging.id || g.targetId === prod.id))
        app.app.grants.deny(g.id);
    for (const argv of [
      ['status', '--app', 'acme-staging'],
      ['deploy', '--config', 'acme-staging'],
    ]) {
      // (A prod read may be auto-approved: Fly.io read grants are scoped. Count rows, whatever their state.)
      const rows = (id: string) => app.app.repos.grants.all().filter((g) => g.targetId === id).length;
      const [p0, s0] = [rows(prod.id), rows(staging.id)];
      void client.call('exec_authorize', { tool: 'fly', argv, cwd: '/tmp' }).catch(() => undefined);
      await vi.waitFor(() => expect(rows(prod.id)).toBe(p0 + 1));
      expect(rows(staging.id)).toBe(s0);
      for (const g of app.app.repos.grants.all())
        if (g.state === 'requested' && g.targetId === prod.id) app.app.grants.deny(g.id);
    }
    client.close();
  });
});

describe('BrokerHost: a staging target on the same app as prod (row 164)', () => {
  it('`fly deploy --app acme-web` matches both and goes to production, which asks with verification', async () => {
    t = makeTestApp({ mfa: 'ok', cli: fakeCli(), fetch: fakeFetch });
    const app = t;
    const prod = await prodTarget(app, CASES[0]); // app acme-web
    const staging: Target = {
      ...prod,
      id: idFrom<'TargetId'>('tgt_fly_staging'),
      name: 'fly staging',
      env: 'staging',
      policy: 'always',
      credentialRef: 'styx:v1:fly:tgt_fly_staging:oauth',
    };
    app.app.repos.targets.upsert(staging); // same app as prod
    await app.vault.set(staging.credentialRef ?? '', JSON.stringify({ token: 'FIXTURE-fly-login' }));
    const client = await connect(app);
    void client
      .call('exec_authorize', { tool: 'fly', argv: ['deploy', '--app', 'acme-web'], cwd: '/tmp' })
      .catch(() => undefined);
    await vi.waitFor(() =>
      expect(
        app.app.repos.grants
          .all()
          .filter((g) => g.state === 'requested' && (g.targetId === prod.id || g.targetId === staging.id))
          .map((g) => g.targetId),
      ).toEqual([prod.id]),
    );
    // Staging's `always` policy never decides it: nothing was issued on the staging target.
    expect(app.app.repos.grants.all().some((g) => g.targetId === staging.id)).toBe(false);
    client.close();
  });
});

describe('GrantService: a staging target sharing the prod app is allowed, and the grant row says so (row 164)', () => {
  it('issues, and the granted audit row records sharesProdProject: true; an unshared one does not', async () => {
    t = makeTestApp({ mfa: 'ok', cli: fakeCli(), fetch: fakeFetch });
    const app = t;
    const prod = await prodTarget(app, CASES[0]); // app acme-web
    const staging: Target = {
      ...prod,
      id: idFrom<'TargetId'>('tgt_fly_staging'),
      name: 'fly staging',
      env: 'staging',
      policy: 'always',
      credentialRef: 'styx:v1:fly:tgt_fly_staging:oauth',
    };
    app.app.repos.targets.upsert(staging); // same app as prod
    await app.vault.set(staging.credentialRef ?? '', JSON.stringify({ token: 'FIXTURE-fly-login' }));
    const out = await app.app.grants.request({
      sessionId: SESSION,
      targetId: staging.id,
      scope: ['deploy'],
      reason: 'r',
      triggeredBy: 'test',
    });
    expect(out.kind).toBe('active');
    const granted = (id: string) =>
      app.app.repos.audit.all().filter((e) => e.targetId === id && e.action === 'granted');
    expect(granted(staging.id).at(-1)?.detail).toMatchObject({ sharesProdProject: true });
    // The prod target's own grant is never flagged, even while staging shares its app (the sheet's line is non-prod only).
    const prodGrant = await app.app.grants.request({
      sessionId: SESSION,
      targetId: prod.id,
      scope: ['deploy'],
      reason: 'r',
      triggeredBy: 'test',
    });
    if (prodGrant.kind !== 'pending') throw new Error('prod deploy must ask');
    await app.app.grants.approve(prodGrant.grant.id, '1h');
    expect(granted(prod.id).at(-1)?.detail).not.toHaveProperty('sharesProdProject');
    // A staging target on its own app is not flagged: covered by prodReachOf's table in core.
  });

  it('a staging target with no app chosen is flagged when a prod Fly.io target exists (it falls back to the only app)', async () => {
    t = makeTestApp({ mfa: 'ok', cli: fakeCli(), fetch: fakeFetch });
    const app = t;
    const prod = await prodTarget(app, CASES[0]);
    const staging: Target = {
      ...prod,
      id: idFrom<'TargetId'>('tgt_fly_staging'),
      name: 'fly staging',
      env: 'staging',
      policy: 'always',
      config: {},
      credentialRef: 'styx:v1:fly:tgt_fly_staging:oauth',
    };
    app.app.repos.targets.upsert(staging);
    await app.vault.set(staging.credentialRef ?? '', JSON.stringify({ token: 'FIXTURE-fly-login' }));
    const out = await app.app.grants.request({
      sessionId: SESSION,
      targetId: staging.id,
      scope: ['deploy'],
      reason: 'r',
      triggeredBy: 'test',
    });
    expect(out.kind).toBe('active');
    const row = app.app.repos.audit
      .all()
      .filter((e) => e.targetId === staging.id && e.action === 'granted')
      .at(-1);
    expect(row?.detail).toMatchObject({ sharesProdProject: true });
  });
});

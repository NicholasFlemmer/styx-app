import { commands, fixtures } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { makeTestApp } from '../../test-support';

const { ids } = fixtures;

/** Issue #5: a Supabase target names the project it acts on; nothing falls back to "the first project". */
const TWO = [
  { id: 'prodrefaaaaaaaaaaaaa', ref: 'prodrefaaaaaaaaaaaaa', name: 'acme', region: 'eu-west-1' },
  { id: 'stagingrefbbbbbbbbbb', ref: 'stagingrefbbbbbbbbbb', name: 'acme-staging', region: 'us-east-1' },
];

function setup(projects: unknown = TWO) {
  const fakeFetch = (async (url: string | URL | Request) =>
    String(url).startsWith('https://api.supabase.com/v1/projects')
      ? new Response(JSON.stringify(projects), { status: 200 })
      : new Response('nope', { status: 404 })) as unknown as typeof fetch;
  return makeTestApp({ fetch: fakeFetch });
}

describe('target.connect.projects / target.setProject (Supabase project per target)', () => {
  it('lists the projects a pasted token reaches; output matches the contract; refuses providers without projects', async () => {
    const { app, sender } = setup();
    const r = await app.bus.dispatch(sender, 'target.connect.projects', {
      provider: 'supabase',
      source: { kind: 'token', token: 'sbp_FIXTURE' },
    });
    expect(r).toEqual({
      ok: true,
      value: {
        projects: [
          { id: 'prodrefaaaaaaaaaaaaa', name: 'acme', region: 'eu-west-1' },
          { id: 'stagingrefbbbbbbbbbb', name: 'acme-staging', region: 'us-east-1' },
        ],
      },
    });
    if (r.ok) expect(commands['target.connect.projects'].output.safeParse(r.value).success).toBe(true);
    // The token is never echoed back.
    expect(JSON.stringify(r)).not.toContain('sbp_FIXTURE');
    expect(
      await app.bus.dispatch(sender, 'target.connect.projects', {
        provider: 'github',
        source: { kind: 'token', token: 'x' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
    expect(
      await app.bus.dispatch(sender, 'target.connect.projects', {
        provider: 'supabase',
        source: { kind: 'cli', account: '-x; rm' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
    // An unconnected target has no credential to list with.
    const start = await app.bus.dispatch(sender, 'target.connect.start', {
      projectId: ids.project.acmeShop,
      provider: 'supabase',
      env: 'staging',
    });
    if (!start.ok) throw new Error(start.error.message);
    expect(
      await app.bus.dispatch(sender, 'target.connect.projects', {
        provider: 'supabase',
        source: { kind: 'target', targetId: start.value.targetId },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
  });

  it('saveToken needs a pick when the account has several projects, and stores it as config.ref', async () => {
    const { app, sender } = setup();
    const start = await app.bus.dispatch(sender, 'target.connect.start', {
      projectId: ids.project.acmeShop,
      provider: 'supabase',
      env: 'staging',
    });
    if (!start.ok) throw new Error(start.error.message);
    const { targetId } = start.value;
    const refused = await app.bus.dispatch(sender, 'target.connect.saveToken', {
      targetId,
      token: 'sbp_FIXTURE',
    });
    expect(refused).toMatchObject({ ok: false, error: { code: 'provider-error' } });
    expect(app.repos.targets.get(targetId)).toMatchObject({ credentialRef: null, health: 'unconnected' });
    const saved = await app.bus.dispatch(sender, 'target.connect.saveToken', {
      targetId,
      token: 'sbp_FIXTURE',
      project: 'stagingrefbbbbbbbbbb',
    });
    expect(saved).toMatchObject({ ok: true });
    expect(app.repos.targets.get(targetId)).toMatchObject({
      health: 'ok',
      config: { ref: 'stagingrefbbbbbbbbbb' },
    });
    // A ref that is not a plain id never reaches main.
    expect(
      await app.bus.dispatch(sender, 'target.connect.saveToken', {
        targetId,
        token: 'sbp_FIXTURE',
        project: '--project-ref=x',
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
  });

  it('an existing target without a ref: test says it needs a project (no expiry, no banner); setProject fixes it, audited', async () => {
    const { app, sender, vault, win } = setup();
    const id = ids.target.supabaseProd;
    const before = app.repos.targets.get(id);
    if (!before?.credentialRef) throw new Error('fixture target is not connected');
    await vault.set(before.credentialRef, JSON.stringify({ token: 'sbp_FIXTURE' }));
    app.repos.targets.upsert({ ...before, config: {} });

    const tested = await app.bus.dispatch(sender, 'target.test', { targetId: id });
    expect(tested).toEqual({
      ok: true,
      value: {
        ok: false,
        message: 'This Supabase account has several projects. Choose the one this target uses.',
      },
    });
    expect(app.repos.targets.get(id)?.health).toBe('ok');
    expect(win.events('banner.set')).toEqual([]);

    expect(
      await app.bus.dispatch(sender, 'target.setProject', { targetId: id, project: 'notinaccount' }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
    expect(app.repos.targets.get(id)?.config).toEqual({});

    expect(
      await app.bus.dispatch(sender, 'target.setProject', { targetId: id, project: 'prodrefaaaaaaaaaaaaa' }),
    ).toEqual({ ok: true, value: {} });
    expect(app.repos.targets.get(id)?.config).toEqual({ ref: 'prodrefaaaaaaaaaaaaa' });
    const row = app.repos.audit
      .all()
      .filter((e) => e.targetId === id && e.triggeredBy === 'project chosen')
      .at(-1);
    expect(row).toMatchObject({ action: 'connected', detail: { project: 'prodrefaaaaaaaaaaaaa' } });

    expect(await app.bus.dispatch(sender, 'target.test', { targetId: id })).toEqual({
      ok: true,
      value: { ok: true, message: 'acme (prodrefaaaaaaaaaaaaa)' },
    });

    // Switching records where it came from.
    await app.bus.dispatch(sender, 'target.setProject', { targetId: id, project: 'stagingrefbbbbbbbbbb' });
    expect(
      app.repos.audit
        .all()
        .filter((e) => e.targetId === id && e.triggeredBy === 'project chosen')
        .at(-1)?.detail,
    ).toEqual({ project: 'stagingrefbbbbbbbbbb', from: 'prodrefaaaaaaaaaaaaa' });
  });

  it('setProject refuses providers without projects and unconnected targets', async () => {
    const { app, sender } = setup();
    expect(
      await app.bus.dispatch(sender, 'target.setProject', { targetId: ids.target.awsProd, project: 'x' }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
    const start = await app.bus.dispatch(sender, 'target.connect.start', {
      projectId: ids.project.acmeShop,
      provider: 'supabase',
      env: 'preview',
    });
    if (!start.ok) throw new Error(start.error.message);
    expect(
      await app.bus.dispatch(sender, 'target.setProject', {
        targetId: start.value.targetId,
        project: 'prodrefaaaaaaaaaaaaa',
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
  });

  // Review M1: grants approved for one project must not carry on against another.
  describe('re-pointing a target ends its grants, each with an audited row', () => {
    /** The fixture's Supabase prod target, connected with a token, holding one live grant and one open request. */
    async function connected(config: Record<string, string>) {
      const t = setup();
      const id = ids.target.supabaseProd;
      const target = t.app.repos.targets.get(id);
      if (!target?.credentialRef) throw new Error('fixture target is not connected');
      await t.vault.set(target.credentialRef, JSON.stringify({ token: 'sbp_FIXTURE' }));
      t.app.repos.targets.upsert({ ...target, config });
      const requested = t.app.repos.grants.get(ids.grant.supabaseCodex);
      if (!requested) throw new Error('fixture grant');
      const now = t.app.clock.now();
      const active = {
        ...requested,
        id: 'grant-live-supabase' as typeof requested.id,
        state: 'active' as const,
        issuedAt: now,
        expiresAt: now + 3_600_000,
        duration: '1h' as const,
        decidedBy: 'user' as const,
      };
      t.app.repos.grants.upsert(active);
      return { ...t, id, activeId: active.id };
    }
    const revokedRows = (app: ReturnType<typeof setup>['app'], triggeredBy: string) =>
      app.repos.audit.all().filter((e) => e.action === 'revoked' && e.triggeredBy === triggeredBy);

    it('setProject to another project revokes live grants and cancels open requests', async () => {
      const { app, sender, id, activeId } = await connected({ ref: 'prodrefaaaaaaaaaaaaa' });
      expect(
        await app.bus.dispatch(sender, 'target.setProject', {
          targetId: id,
          project: 'stagingrefbbbbbbbbbb',
        }),
      ).toEqual({ ok: true, value: {} });
      expect(app.repos.grants.get(activeId)).toMatchObject({
        state: 'revoked',
        revokeReason: 'target-removed',
      });
      expect(app.repos.grants.get(ids.grant.supabaseCodex)?.state).not.toBe('requested');
      expect(revokedRows(app, 'project changed').map((e) => e.grantId)).toEqual([activeId]);
    });

    it('choosing the project the target already has changes nothing', async () => {
      const { app, sender, id, activeId } = await connected({ ref: 'prodrefaaaaaaaaaaaaa' });
      const before = app.repos.audit.all().length;
      await app.bus.dispatch(sender, 'target.setProject', { targetId: id, project: 'prodrefaaaaaaaaaaaaa' });
      expect(app.repos.grants.get(activeId)?.state).toBe('active');
      expect(app.repos.audit.all()).toHaveLength(before);
    });

    it('a token reconnect that changes the project revokes too, and audits project + from (L2)', async () => {
      const { app, sender, id, activeId } = await connected({ ref: 'prodrefaaaaaaaaaaaaa' });
      expect(
        await app.bus.dispatch(sender, 'target.connect.saveToken', {
          targetId: id,
          token: 'sbp_FIXTURE',
          project: 'stagingrefbbbbbbbbbb',
        }),
      ).toMatchObject({ ok: true });
      expect(app.repos.grants.get(activeId)?.state).toBe('revoked');
      const row = app.repos.audit
        .all()
        .filter((e) => e.targetId === id && e.action === 'connected')
        .at(-1);
      expect(row?.detail).toMatchObject({ project: 'stagingrefbbbbbbbbbb', from: 'prodrefaaaaaaaaaaaaa' });
    });

    it('a token reconnect on the same project keeps the grants', async () => {
      const { app, sender, id, activeId } = await connected({ ref: 'prodrefaaaaaaaaaaaaa' });
      await app.bus.dispatch(sender, 'target.connect.saveToken', { targetId: id, token: 'sbp_FIXTURE' });
      expect(app.repos.grants.get(activeId)?.state).toBe('active');
    });

    it('project.json re-pointing a connected target is audited and revokes (L1)', async () => {
      const { app, id, activeId } = await connected({ ref: 'prodrefaaaaaaaaaaaaa' });
      const before = app.repos.targets.get(id);
      if (!before) throw new Error('target');
      const after = { ...before, config: { ref: 'stagingrefbbbbbbbbbb' } };
      app.repos.targets.upsert(after);
      app.targets.fileConfigChanged(before, after);
      expect(app.repos.grants.get(activeId)?.state).toBe('revoked');
      expect(revokedRows(app, 'project changed in project.json')).toHaveLength(1);
      expect(
        app.repos.audit
          .all()
          .filter((e) => e.targetId === id && e.triggeredBy === 'project.json')
          .at(-1)?.detail,
      ).toEqual({ project: 'stagingrefbbbbbbbbbb', from: 'prodrefaaaaaaaaaaaaa' });
      // Other config keys changing is not a re-point.
      const other = { ...after, config: { ...after.config, note: 'x' } };
      const n = app.repos.audit.all().length;
      app.targets.fileConfigChanged(after, other);
      expect(app.repos.audit.all()).toHaveLength(n);
    });
  });

  // Review M2: what a pasted token may look like, and a network failure never echoes the request.
  it("token inputs are printable ASCII without spaces; a paste's surrounding whitespace is trimmed", async () => {
    const { app, sender } = setup();
    for (const token of ['sbp x', 'sbp\u0000x', 'sbp\u00e9', '   '])
      expect(
        await app.bus.dispatch(sender, 'target.connect.projects', {
          provider: 'supabase',
          source: { kind: 'token', token },
        }),
        JSON.stringify(token),
      ).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
    expect(
      await app.bus.dispatch(sender, 'target.connect.projects', {
        provider: 'supabase',
        source: { kind: 'token', token: 'sbp_FIXTURE\n' },
      }),
    ).toMatchObject({ ok: true });
  });

  it('a network failure while listing reads as a fixed message, never the request', async () => {
    const throwing = (async () => {
      throw new Error(
        'connect ECONNREFUSED https://api.supabase.com/v1/projects Authorization: Bearer sbp_FIXTURE',
      );
    }) as unknown as typeof fetch;
    const { app, sender } = makeTestApp({ fetch: throwing });
    const r = await app.bus.dispatch(sender, 'target.connect.projects', {
      provider: 'supabase',
      source: { kind: 'token', token: 'sbp_FIXTURE' },
    });
    expect(r).toEqual({
      ok: false,
      error: { code: 'provider-error', message: 'Could not reach Supabase to list projects' },
    });
  });
});

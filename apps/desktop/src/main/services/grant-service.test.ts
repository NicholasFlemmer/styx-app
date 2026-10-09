import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fixtures,
  targetDerivedState,
  tableFrom,
  type ProjectFileV1,
  type ReadModel,
  type ReadModelSnapshot,
} from '@styx/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestApp, type TestApp } from '../test-support';

const { ids } = fixtures;
const HOUR = 3_600_000;

const modelOf = (snap: ReadModelSnapshot): ReadModel => ({
  ...snap,
  runs: Object.fromEntries(snap.runs.map((r) => [r.projectId, r])),
  devices: Object.fromEntries(snap.devices.map((d) => [d.projectId, d])),
  deploys: Object.fromEntries(snap.deploys.map((d) => [d.deployId, d])),
  agentSetup: Object.fromEntries(snap.agentSetup.map((s) => [s.agent, s])),
  projects: tableFrom(snap.projects),
  repos: tableFrom(snap.repos),
  worktrees: tableFrom(snap.worktrees),
  sessions: tableFrom(snap.sessions),
  targets: tableFrom(snap.targets),
  grants: tableFrom(snap.grants),
  auditEntries: tableFrom(snap.auditEntries),
  policies: tableFrom(snap.policies),
  pendingAsks: tableFrom(snap.pendingAsks),
  notifications: tableFrom(snap.notifications),
  settings: { app: snap.settings.app, project: {} },
});

/**
 * The idle Gemini session on acme-shop asks for Supabase prod (ask + MFA: prod ∧ write). Supabase's token is not
 * narrowed per grant, so a write here is approved once only (issue #29).
 */
async function requestSupabase(t: TestApp, scope: ('read' | 'write')[] = ['read', 'write']) {
  const target = t.app.repos.targets.get(ids.target.supabaseProd);
  if (!target?.credentialRef) throw new Error('fixture target');
  await t.vault.set(target.credentialRef, JSON.stringify({ token: 'sbp_test' }));
  return t.app.grants.request({
    sessionId: ids.session.gemini,
    targetId: ids.target.supabaseProd,
    scope,
    reason: 'migration 0042',
    triggeredBy: 'mcp:request_access',
  });
}

describe('GrantService', () => {
  it('request → pending ask, session needs-you, access-request message, ask.opened event, audit requested', async () => {
    const t = makeTestApp();
    const out = await requestSupabase(t);
    expect(out.kind).toBe('pending');
    if (out.kind !== 'pending') return;
    expect(out.grant.state).toBe('requested');
    expect(t.app.repos.sessions.get(ids.session.gemini)?.state).toBe('needs-you');
    expect(t.app.repos.pendingAsks.get(out.ask.id)).toMatchObject({
      kind: 'grant',
      grantId: out.grant.id,
      state: 'open',
      position: 0,
    });
    const msgs = t.app.repos.transcripts.last(ids.session.gemini);
    expect(msgs.at(-1)).toMatchObject({
      payload: { kind: 'access-request', grantId: out.grant.id, scope: ['read', 'write'] },
      askId: out.ask.id,
    });
    expect(t.win.events('ask.opened')).toEqual([
      { askId: out.ask.id, sessionId: ids.session.gemini, projectId: ids.project.acmeShop },
    ]);
    const requested = t.app.repos.audit
      .all()
      .find((e) => e.grantId === out.grant.id && e.action === 'requested');
    expect(requested).toMatchObject({
      actorKind: 'agent',
      actorLabel: 'Gemini',
      targetLabel: 'supabase-prod',
      triggeredBy: 'mcp:request_access',
      scope: ['read', 'write'],
    });
  });

  it('approve with FakeMfa → active, audit granted (mfaVerified), system message, ask resolved, session working, target open', async () => {
    const t = makeTestApp();
    const out = await requestSupabase(t, ['read']);
    if (out.kind !== 'pending') throw new Error('expected pending');
    const decisions: string[] = [];
    t.app.grants.onDecision((g, o) => decisions.push(`${g.id}:${o}`));
    const g = await t.app.grants.approve(out.grant.id, '1h');
    expect(g).toMatchObject({
      state: 'active',
      duration: '1h',
      mfaVerified: true,
      decidedBy: 'user',
      issuedAt: t.clock.now(),
      expiresAt: t.clock.now() + HOUR,
      idleExpiresAt: t.clock.now() + HOUR,
    });
    expect(t.app.grants.issuedCredential(g.id)).toMatchObject({
      kind: 'env',
      env: { SUPABASE_ACCESS_TOKEN: 'sbp_test' },
    });
    const granted = t.app.repos.audit.all().find((e) => e.grantId === g.id && e.action === 'granted');
    expect(granted).toMatchObject({
      actorKind: 'you',
      actorLabel: 'you',
      triggeredBy: 'grant sheet',
      duration: '1h',
      detail: { decidedBy: 'user', mfaVerified: true },
    });
    expect(t.app.audit.verifyChain()).toMatchObject({ ok: true }); // seeded rows are re-chained; new rows chain from them
    expect(t.app.repos.transcripts.last(ids.session.gemini).at(-1)).toMatchObject({
      payload: { kind: 'system' },
      body: 'grant: supabase-prod · read · expires in 1h',
    });
    expect(t.app.repos.pendingAsks.get(out.ask.id)).toMatchObject({
      state: 'resolved',
      resolution: { kind: 'grant', outcome: 'granted' },
    });
    expect(t.app.repos.sessions.get(ids.session.gemini)?.state).toBe('working');
    expect(t.win.events('grant.result')).toEqual([
      { grantId: g.id, sessionId: ids.session.gemini, outcome: 'granted' },
    ]);
    expect(decisions).toEqual([`${g.id}:granted`]);
    const state = targetDerivedState(
      modelOf(t.app.publisher.snapshot()),
      ids.target.supabaseProd,
      t.clock.now(),
    );
    expect(state).toMatchObject({ kind: 'open', grantId: g.id, label: 'open · 1h left' });
  });

  it('approve refuses without MFA on prod write and reports mfa-failed', async () => {
    const t = makeTestApp({ mfa: 'failed' });
    const out = await requestSupabase(t);
    if (out.kind !== 'pending') throw new Error('expected pending');
    await expect(t.app.grants.approve(out.grant.id, '1h')).rejects.toMatchObject({ code: 'mfa-failed' });
    expect(t.app.repos.grants.get(out.grant.id)?.state).toBe('requested');
  });

  it('an app-initiated request (no session) on an ask target is approved by the press itself: MFA, decidedBy user, the button as trigger', async () => {
    const t = makeTestApp();
    const target = t.app.repos.targets.get(ids.target.supabaseProd);
    if (!target?.credentialRef) throw new Error('fixture target');
    await t.vault.set(target.credentialRef, JSON.stringify({ token: 'sbp_test' }));
    const out = await t.app.grants.request({
      sessionId: null,
      targetId: ids.target.supabaseProd,
      scope: ['deploy'],
      reason: 'Deploy from Styx',
      triggeredBy: 'Deploy · Supabase prod',
    });
    if (out.kind !== 'active') throw new Error(`expected active, got ${out.kind}`);
    expect(out.grant).toMatchObject({
      state: 'active',
      duration: 'once',
      mfaVerified: true,
      decidedBy: 'user',
      sessionId: null,
    });
    expect(t.app.repos.pendingAsks.all().some((a) => a.grantId === out.grant.id)).toBe(false);
    const rows = t.app.repos.audit.all().filter((e) => e.grantId === out.grant.id);
    expect(rows.map((e) => e.action)).toEqual(['requested', 'granted']);
    expect(rows[1]).toMatchObject({ actorKind: 'you', triggeredBy: 'Deploy · Supabase prod' });

    // The press does not skip MFA: a refused verification is the refusal.
    const refused = makeTestApp({ mfa: 'failed' });
    const t2 = refused.app.repos.targets.get(ids.target.supabaseProd);
    if (!t2?.credentialRef) throw new Error('fixture target');
    await refused.vault.set(t2.credentialRef, JSON.stringify({ token: 'sbp_test' }));
    await expect(
      refused.app.grants.request({
        sessionId: null,
        targetId: ids.target.supabaseProd,
        scope: ['deploy'],
        reason: 'Deploy from Styx',
        triggeredBy: 'Deploy · Supabase prod',
      }),
    ).rejects.toMatchObject({ code: 'mfa-failed' });
  });

  it('deny → denied, audit denied, ask resolved, session leaves needs-you', async () => {
    const t = makeTestApp();
    const out = await requestSupabase(t);
    if (out.kind !== 'pending') throw new Error('expected pending');
    const g = t.app.grants.deny(out.grant.id);
    expect(g).toMatchObject({ state: 'denied', revokedAt: t.clock.now() });
    expect(t.app.repos.audit.all().find((e) => e.grantId === g.id && e.action === 'denied')).toMatchObject({
      actorKind: 'you',
      triggeredBy: 'grant sheet',
    });
    expect(t.app.repos.pendingAsks.get(out.ask.id)?.state).toBe('resolved');
    expect(t.app.repos.sessions.get(ids.session.gemini)?.state).toBe('working');
    expect(t.win.events('grant.result')).toEqual([
      { grantId: g.id, sessionId: ids.session.gemini, outcome: 'denied' },
    ]);
  });

  it('revoke on a still-requested grant denies it (spec §1: the only user path out of requested)', async () => {
    const t = makeTestApp();
    const out = await requestSupabase(t);
    if (out.kind !== 'pending') throw new Error('expected pending');
    const r = t.app.grants.revoke(out.grant.id);
    expect(r.state).toBe('denied');
    expect(t.app.repos.audit.all().some((e) => e.grantId === r.id && e.action === 'denied')).toBe(true);
  });

  it('revoke → revoked, credential dropped, audit revoked by you, target locked', async () => {
    const t = makeTestApp();
    const out = await requestSupabase(t, ['read']);
    if (out.kind !== 'pending') throw new Error('expected pending');
    const g = await t.app.grants.approve(out.grant.id, 'session');
    expect(g.expiresAt).toBeNull();
    const r = t.app.grants.revoke(g.id);
    expect(r).toMatchObject({ state: 'revoked', revokeReason: 'user', revokedAt: t.clock.now() });
    expect(t.app.grants.issuedCredential(g.id)).toBeNull();
    expect(t.app.repos.audit.all().find((e) => e.grantId === g.id && e.action === 'revoked')).toMatchObject({
      actorKind: 'you',
      triggeredBy: 'lock glyph',
      detail: { reason: 'user' },
    });
    expect(
      targetDerivedState(modelOf(t.app.publisher.snapshot()), ids.target.supabaseProd, t.clock.now()).kind,
    ).toBe('locked');
  });

  it('auto-approves via target policy always (Vercel preview) with an audit row citing the decision', async () => {
    const t = makeTestApp();
    const target = t.app.repos.targets.get(ids.target.vercelPreview);
    if (!target?.credentialRef) throw new Error('fixture target');
    await t.vault.set(target.credentialRef, JSON.stringify({ token: 'vt' }));
    const out = await t.app.grants.request({
      sessionId: ids.session.gemini,
      targetId: ids.target.vercelPreview,
      scope: ['read'],
      reason: '$ vercel ls',
      triggeredBy: '$ vercel ls',
    });
    // The fixture already holds a persistent `always` grant covering read+deploy on this target.
    expect(out).toMatchObject({
      kind: 'active',
      decidedBy: 'persistent-grant',
      grant: { id: ids.grant.vercelPreviewAlways },
    });
    const out2 = await t.app.grants.request({
      sessionId: ids.session.gemini,
      targetId: ids.target.vercelPreview,
      scope: ['write'],
      reason: '$ vercel env add',
      triggeredBy: '$ vercel env add',
    });
    expect(out2).toMatchObject({
      kind: 'active',
      decidedBy: 'target-policy',
      grant: { state: 'active', duration: 'always', sessionId: null },
    });
    expect(t.app.repos.sessions.get(ids.session.gemini)?.state).toBe('idle');
  });

  it('once grants are revoked after the first use; use re-arms idle and audits used', async () => {
    const t = makeTestApp();
    const out = await requestSupabase(t);
    if (out.kind !== 'pending') throw new Error('expected pending');
    const g = await t.app.grants.approve(out.grant.id, 'once');
    t.clock.advance(60_000);
    const { grant, useId } = t.app.grants.use(g.id, {
      command: '$ supabase db push',
      scopeUsed: 'write',
      via: 'shim',
      sessionId: ids.session.gemini,
    });
    expect(grant).toMatchObject({ state: 'revoked', revokeReason: 'once-used', lastUsedAt: t.clock.now() });
    expect(t.app.repos.grantUses.get(useId)).toMatchObject({
      grantId: g.id,
      via: 'shim',
      command: '$ supabase db push',
    });
    const used = t.app.repos.audit.all().find((e) => e.grantId === g.id && e.action === 'used');
    expect(used).toMatchObject({
      actorKind: 'agent',
      actorLabel: 'Gemini',
      triggeredBy: '$ supabase db push',
      scope: ['write'],
      detail: { via: 'shim' },
    });
  });

  describe('timers', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('expires a 1h grant when its timer fires (fake clock advanced past expiresAt)', async () => {
      const t = makeTestApp();
      const out = await requestSupabase(t);
      if (out.kind !== 'pending') throw new Error('expected pending');
      const g = await t.app.grants.approve(out.grant.id, '1h');
      t.clock.advance(HOUR + 1);
      vi.advanceTimersByTime(HOUR + 1);
      const after = t.app.repos.grants.get(g.id);
      expect(after).toMatchObject({ state: 'expired', revokeReason: 'expired', revokedAt: t.clock.now() });
      expect(t.app.repos.audit.all().find((e) => e.grantId === g.id && e.action === 'expired')).toMatchObject(
        { actorKind: 'system', triggeredBy: 'expiry timer', detail: { reason: 'expired' } },
      );
      expect(t.app.grants.issuedCredential(g.id)).toBeNull();
      expect(t.win.events('grant.result').length).toBe(1); // only the original 'granted'
    });

    it('sweep catches grants whose timers lagged (after sleep)', async () => {
      const t = makeTestApp();
      const out = await requestSupabase(t);
      if (out.kind !== 'pending') throw new Error('expected pending');
      const g = await t.app.grants.approve(out.grant.id, '1h');
      t.clock.advance(2 * HOUR);
      t.app.grants.sweepExpired();
      expect(t.app.repos.grants.get(g.id)?.state).toBe('expired');
    });
  });
});

describe('GrantService security regressions', () => {
  it('L1: a duplicate request for the same session + target + scope returns the pending grant instead of a second row', async () => {
    const t = makeTestApp();
    const a = await requestSupabase(t);
    const b = await requestSupabase(t);
    expect(a.kind).toBe('pending');
    expect(b.kind).toBe('pending');
    if (a.kind !== 'pending' || b.kind !== 'pending') return;
    expect(b.grant.id).toBe(a.grant.id);
    expect(b.ask.id).toBe(a.ask.id);
    expect(
      t.app.repos.grants
        .bySession(ids.session.gemini)
        .filter((g) => g.state === 'requested' && g.targetId === ids.target.supabaseProd),
    ).toHaveLength(1);
    expect(t.app.repos.pendingAsks.openBySession(ids.session.gemini)).toHaveLength(1);
    // A different scope set is a new ask (queued behind the first).
    const c = await t.app.grants.request({
      sessionId: ids.session.gemini,
      targetId: ids.target.supabaseProd,
      scope: ['read'],
      reason: 'x',
      triggeredBy: 'mcp:request_access',
    });
    expect(c.kind).toBe('pending');
    if (c.kind === 'pending') expect(c.grant.id).not.toBe(a.grant.id);
  });

  it('M2: an unscoped provider on prod requires MFA even for a read grant', async () => {
    const t = makeTestApp({ mfa: 'failed' });
    const target = t.app.repos.targets.get(ids.target.supabaseProd);
    if (!target?.credentialRef) throw new Error('fixture target');
    await t.vault.set(target.credentialRef, JSON.stringify({ token: 'sbp_test' }));
    const out = await t.app.grants.request({
      sessionId: ids.session.gemini,
      targetId: ids.target.supabaseProd,
      scope: ['read'],
      reason: 'peek',
      triggeredBy: 'mcp:request_access',
    });
    if (out.kind !== 'pending') throw new Error('expected pending');
    await expect(t.app.grants.approve(out.grant.id, '1h')).rejects.toMatchObject({ code: 'mfa-failed' });
    expect(t.app.repos.grants.get(out.grant.id)?.state).toBe('requested');
    const ok = makeTestApp({ mfa: 'ok' });
    await ok.vault.set(target.credentialRef, JSON.stringify({ token: 'sbp_test' }));
    const out2 = await ok.app.grants.request({
      sessionId: ids.session.gemini,
      targetId: ids.target.supabaseProd,
      scope: ['read'],
      reason: 'peek',
      triggeredBy: 'mcp:request_access',
    });
    if (out2.kind !== 'pending') throw new Error('expected pending');
    expect(await ok.app.grants.approve(out2.grant.id, '1h')).toMatchObject({
      state: 'active',
      mfaVerified: true,
    });
  });

  it('M2: an auto policy on a prod target with an unscoped adapter downgrades to ask + MFA', async () => {
    const t = makeTestApp({ mfa: 'failed' });
    const target = t.app.repos.targets.get(ids.target.supabaseProd);
    if (!target?.credentialRef) throw new Error('fixture target');
    t.app.repos.targets.upsert({ ...target, policy: 'always' });
    await t.vault.set(target.credentialRef, JSON.stringify({ token: 'sbp_test' }));
    const out = await t.app.grants.request({
      sessionId: ids.session.gemini,
      targetId: ids.target.supabaseProd,
      scope: ['read'],
      reason: 'peek',
      triggeredBy: 'mcp:request_access',
    });
    expect(out.kind).toBe('pending'); // not auto-issued
    if (out.kind !== 'pending') return;
    await expect(t.app.grants.approve(out.grant.id, '1h')).rejects.toMatchObject({ code: 'mfa-failed' });
    // Non-prod stays auto (the Vercel preview target has the same `always` policy).
    const preview = t.app.repos.targets.get(ids.target.vercelPreview);
    if (!preview?.credentialRef) throw new Error('fixture target');
    await t.vault.set(preview.credentialRef, JSON.stringify({ token: 'vt' }));
    const auto = await t.app.grants.request({
      sessionId: ids.session.gemini,
      targetId: ids.target.vercelPreview,
      scope: ['write'],
      reason: 'x',
      triggeredBy: 'mcp:request_access',
    });
    expect(auto.kind).toBe('active');
  });

  it('M1: reasons and triggers are redacted on request', async () => {
    const t = makeTestApp();
    const ghp = `ghp_${'d'.repeat(36)}`;
    const out = await t.app.grants.request({
      sessionId: ids.session.gemini,
      targetId: ids.target.supabaseProd,
      scope: ['read'],
      reason: `use ${ghp}`,
      triggeredBy: `$ x --token ${ghp}`,
    });
    if (out.kind !== 'pending') throw new Error('expected pending');
    expect(out.grant.reason).toBe('use [redacted]');
    const dump = JSON.stringify([
      t.app.repos.audit.all(),
      t.app.repos.transcripts.last(ids.session.gemini),
      t.app.repos.grants.get(out.grant.id),
    ]);
    expect(dump).not.toContain(ghp);
  });
});

describe('GrantService project-file trust gate (H-1)', () => {
  it('a repo-authored `auto-approve github always` rule asks until project.policy.accept, then auto-issues', async () => {
    const t = makeTestApp();
    const file: ProjectFileV1 = {
      version: 1,
      name: 'acme-shop',
      policies: {
        extra: [
          {
            id: 'gh-all',
            rule: {
              kind: 'auto-approve',
              match: { provider: ['github'] },
              scopes: ['read', 'write'],
              duration: 'always',
            },
            ruleText: 'Auto-approve GitHub',
          },
        ],
      },
    };
    const dir = mkdtempSync(join(tmpdir(), 'styx-h1-'));
    mkdirSync(join(dir, '.styx'));
    writeFileSync(join(dir, '.styx', 'project.json'), JSON.stringify(file));
    const project = t.app.repos.projects.get(ids.project.acmeShop);
    if (!project) throw new Error('fixture project');
    t.app.repos.projects.upsert({ ...project, path: dir });
    const target = t.app.repos.targets.get(ids.target.github);
    if (!target?.credentialRef) throw new Error('fixture target');
    t.app.repos.targets.upsert({ ...target, policy: 'ask', policySource: 'app' });
    await t.vault.set(target.credentialRef, JSON.stringify({ token: 'gh-token' }));
    const req = () =>
      t.app.grants.request({
        sessionId: ids.session.gemini,
        targetId: ids.target.github,
        scope: ['write'],
        reason: '$ gh pr merge 1',
        triggeredBy: '$ gh pr merge 1',
      });

    // Fresh clone: the file's hash is not accepted on this machine → the rule is advisory and the request asks.
    expect(t.app.projects.projectPolicyTrusted(project.id)).toBe(false);
    const first = await req();
    expect(first.kind).toBe('pending');
    if (first.kind !== 'pending') return;
    const requested = t.app.repos.audit
      .all()
      .find((e) => e.action === 'requested' && e.grantId === first.grant.id);
    expect(requested?.detail).toMatchObject({ projectRule: 'project:gh-all' }); // still cited, downgraded to ask
    t.app.grants.deny(first.grant.id);

    const { hash } = await t.app.projects.pendingPolicy(project.id);
    const r = await t.app.bus.dispatch(t.sender, 'project.policy.accept', { projectId: project.id, hash });
    expect(r).toEqual({ ok: true, value: {} });
    expect(t.app.projects.projectPolicyTrusted(project.id)).toBe(true);
    const second = await req();
    expect(second).toMatchObject({
      kind: 'active',
      decidedBy: 'policy',
      grant: { state: 'active', duration: 'always' },
    });

    // Editing the file (new hash) drops back to untrusted until accepted again.
    writeFileSync(
      join(dir, '.styx', 'project.json'),
      JSON.stringify({
        ...file,
        policies: { extra: [{ ...file.policies!.extra![0]!, ruleText: 'changed' }] },
      }),
    );
    expect(t.app.projects.projectPolicyTrusted(project.id)).toBe(false);
  });

  describe('credential freshness (re-auth without a restart)', () => {
    /** Stubs the supabase adapter so the test controls expiry and can count mints. */
    const stubIssue = (t: TestApp, expiresAt: () => number | null) => {
      const adapter = t.app.providers.get('supabase');
      let n = 0;
      const issue = vi.spyOn(adapter, 'issue').mockImplementation(async () => {
        n += 1;
        return { kind: 'env', env: { TOKEN: `mint-${n}` }, expiresAt: expiresAt(), scoped: true };
      });
      const revoke = vi.spyOn(adapter, 'revoke').mockResolvedValue(undefined);
      return { issue, revoke, mints: () => n };
    };

    it('re-mints a bundle that is past expiry and releases the superseded one', async () => {
      const t = makeTestApp();
      const stub = stubIssue(t, () => t.clock.now() + 10 * 60_000);
      const outcome = await requestSupabase(t);
      const grant = await t.app.grants.approve(outcome.grant.id, '1h');
      const first = await t.app.grants.credentialFor(grant.id);
      expect(first.env['TOKEN']).toBe('mint-1');
      // Still fresh: served from cache, no second mint.
      expect((await t.app.grants.credentialFor(grant.id)).env['TOKEN']).toBe('mint-1');
      expect(stub.mints()).toBe(1);
      // Past expiry: the cached bundle is spent, so the next use mints again and hands the old one back.
      t.clock.advance(11 * 60_000);
      expect((await t.app.grants.credentialFor(grant.id)).env['TOKEN']).toBe('mint-2');
      expect(stub.revoke).toHaveBeenCalledWith(expect.objectContaining({ env: { TOKEN: 'mint-1' } }));
    });

    it('treats a bundle inside the skew margin as spent (never hands a CLI a token about to die)', async () => {
      const t = makeTestApp();
      stubIssue(t, () => t.clock.now() + 90_000);
      const grant = await t.app.grants.approve((await requestSupabase(t)).grant.id, '1h');
      expect((await t.app.grants.credentialFor(grant.id)).env['TOKEN']).toBe('mint-1');
      t.clock.advance(45_000); // 45s left — inside the 60s margin
      expect((await t.app.grants.credentialFor(grant.id)).env['TOKEN']).toBe('mint-2');
    });

    it('a null expiry (a PAT) never goes stale', async () => {
      const t = makeTestApp();
      const stub = stubIssue(t, () => null);
      const grant = await t.app.grants.approve((await requestSupabase(t)).grant.id, '1h');
      await t.app.grants.credentialFor(grant.id);
      t.clock.advance(30 * 24 * 3_600_000);
      await t.app.grants.credentialFor(grant.id);
      expect(stub.mints()).toBe(1);
    });

    it('concurrent callers share one re-mint', async () => {
      const t = makeTestApp();
      const stub = stubIssue(t, () => t.clock.now() + 60 * 60_000);
      const grant = await t.app.grants.approve((await requestSupabase(t)).grant.id, '1h');
      await t.app.grants.credentialFor(grant.id);
      t.clock.advance(61 * 60_000);
      const all = await Promise.all([
        t.app.grants.credentialFor(grant.id),
        t.app.grants.credentialFor(grant.id),
        t.app.grants.credentialFor(grant.id),
      ]);
      expect(stub.mints()).toBe(2); // the first mint plus exactly one re-mint
      expect(new Set(all.map((c) => c.env['TOKEN']))).toEqual(new Set(['mint-2']));
    });

    it('invalidate drops the cached bundle so a reconnect takes effect in place', async () => {
      const t = makeTestApp();
      const stub = stubIssue(t, () => null);
      const grant = await t.app.grants.approve((await requestSupabase(t)).grant.id, '1h');
      expect((await t.app.grants.credentialFor(grant.id)).env['TOKEN']).toBe('mint-1');
      t.app.grants.invalidate(grant.targetId);
      expect((await t.app.grants.credentialFor(grant.id)).env['TOKEN']).toBe('mint-2');
      expect(stub.revoke).toHaveBeenCalled();
    });

    it('a revoked grant still refuses, stale bundle or not', async () => {
      const t = makeTestApp();
      stubIssue(t, () => t.clock.now() + 1000);
      const grant = await t.app.grants.approve((await requestSupabase(t)).grant.id, '1h');
      await t.app.grants.credentialFor(grant.id);
      t.app.grants.revoke(grant.id, 'user');
      t.clock.advance(60_000);
      await expect(t.app.grants.credentialFor(grant.id)).rejects.toThrow();
    });
  });
});

describe('GrantService app-minted transient grants (publish / deploy)', () => {
  it('a session-less grant is shared with agents only when it is persistent; a transient one belongs to the app', async () => {
    const t = makeTestApp();
    const svc = t.app.grants;
    const target = t.app.repos.targets.get(ids.target.vercelPreview)!;
    const persistent = t.app.repos.grants.get(ids.grant.vercelPreviewAlways)!;
    expect(persistent).toMatchObject({ sessionId: null, duration: 'always', state: 'active' });
    // Publish / Deploy mint a bounded, session-less grant for one step.
    const transient = {
      ...persistent,
      id: 'grant:transient' as typeof persistent.id,
      duration: '1h' as const,
      expiresAt: t.clock.now() + HOUR,
    };
    t.app.repos.grants.upsert(transient);
    // An agent session sees the persistent one, never the app's transient one.
    expect(svc.covering(target, ids.session.gemini, ['deploy'])?.id).toBe(persistent.id);
    t.app.repos.grants.upsert({
      ...persistent,
      state: 'revoked',
      revokedAt: t.clock.now(),
      revokeReason: 'user',
    });
    expect(svc.covering(target, ids.session.gemini, ['deploy'])).toBeNull();
    // The app itself (no session) still finds what it minted.
    expect(svc.covering(target, null, ['deploy'])?.id).toBe(transient.id);
    // And an agent cannot fetch its credential by id either.
    await expect(
      svc.credentialFor(transient.id, { sessionId: ids.session.gemini, projectId: ids.project.acmeShop }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  describe('once only: production writes on a target whose token is not narrowed per grant (issue #29)', () => {
    const grantedRow = (t: TestApp, grantId: string) =>
      t.app.repos.audit.all().find((e) => e.grantId === grantId && e.action === 'granted');

    it('the ask starts on once and says the credential is unscoped; a 1h pick is clamped to once and audited', async () => {
      const t = makeTestApp();
      const out = await requestSupabase(t);
      if (out.kind !== 'pending') throw new Error('expected pending');
      expect(out.grant.duration).toBe('once');
      expect(t.app.repos.pendingAsks.get(out.ask.id)?.payload).toEqual({
        kind: 'grant',
        grantId: out.grant.id,
        credentialScoped: false,
      });
      const g = await t.app.grants.approve(out.grant.id, '1h');
      expect(g).toMatchObject({
        state: 'active',
        duration: 'once',
        mfaVerified: true,
        sessionId: ids.session.gemini,
      });
      expect(grantedRow(t, g.id)).toMatchObject({
        duration: 'once',
        detail: { decidedBy: 'user', mfaVerified: true, onceOnly: true, requestedDuration: '1h' },
      });
      expect(t.app.audit.verifyChain()).toMatchObject({ ok: true });
      expect(t.app.repos.transcripts.last(ids.session.gemini).at(-1)).toMatchObject({
        payload: { kind: 'system' },
        body: 'grant: supabase-prod · read+write · one command',
      });
      // The first use ends it.
      t.app.grants.use(g.id, {
        command: '$ supabase db push',
        scopeUsed: 'write',
        via: 'shim',
        sessionId: ids.session.gemini,
      });
      expect(t.app.repos.grants.get(g.id)).toMatchObject({ state: 'revoked', revokeReason: 'once-used' });
      expect(t.app.grants.issuedCredential(g.id)).toBeNull();
    });

    it.each(['session', 'always'] as const)(
      'a %s pick is clamped to once too (no detached standing grant)',
      async (duration) => {
        const t = makeTestApp();
        const out = await requestSupabase(t);
        const g = await t.app.grants.approve(out.grant.id, duration);
        expect(g).toMatchObject({
          duration: 'once',
          sessionId: ids.session.gemini,
          expiresAt: t.clock.now() + HOUR,
        });
        expect(grantedRow(t, g.id)?.detail).toMatchObject({ onceOnly: true, requestedDuration: duration });
      },
    );

    it('a once pick is recorded without a requestedDuration; ask.respond (inbox Grant) approves once', async () => {
      const t = makeTestApp();
      const out = await requestSupabase(t);
      if (out.kind !== 'pending') throw new Error('expected pending');
      const r = await t.app.bus.dispatch(t.sender, 'ask.respond', {
        askId: out.ask.id,
        resolution: { kind: 'grant', outcome: 'granted' },
      });
      expect(r).toEqual({ ok: true, value: {} });
      const g = t.app.repos.grants.get(out.grant.id);
      expect(g?.duration).toBe('once');
      expect(grantedRow(t, out.grant.id)?.detail).toEqual({
        decidedBy: 'user',
        mfaVerified: true,
        onceOnly: true,
      });
    });

    it('the IPC command clamps whatever the renderer sends', async () => {
      const t = makeTestApp();
      const out = await requestSupabase(t);
      const r = await t.app.bus.dispatch(t.sender, 'grant.approve', {
        grantId: out.grant.id,
        duration: 'always',
        scope: ['read', 'write'],
      });
      expect(r.ok).toBe(true);
      expect(t.app.repos.grants.get(out.grant.id)).toMatchObject({
        duration: 'once',
        sessionId: ids.session.gemini,
      });
    });

    it('a target policy `always` does not auto-approve it: it asks, once, with MFA', async () => {
      const t = makeTestApp({ mfa: 'failed' });
      const target = t.app.repos.targets.get(ids.target.supabaseProd);
      if (!target) throw new Error('fixture target');
      t.app.repos.targets.upsert({ ...target, policy: 'always' });
      const out = await requestSupabase(t, ['write']);
      expect(out.kind).toBe('pending');
      expect(out.grant.duration).toBe('once');
      await expect(t.app.grants.approve(out.grant.id, 'once')).rejects.toMatchObject({ code: 'mfa-failed' });
    });

    it('narrowing the scope to a read lifts the cap (reads keep the longer durations)', async () => {
      const t = makeTestApp();
      const out = await requestSupabase(t);
      const g = await t.app.grants.approve(out.grant.id, '1h', ['read']);
      expect(g).toMatchObject({ duration: '1h', scope: ['read'], mfaVerified: true });
      expect(grantedRow(t, g.id)?.detail).toEqual({ decidedBy: 'user', mfaVerified: true });
    });

    it('a non-production write on the same provider keeps the longer durations', async () => {
      const t = makeTestApp();
      const side = t.app.repos.targets.get(ids.target.sideSupabase);
      if (!side?.credentialRef) throw new Error('fixture target');
      t.app.repos.targets.upsert({ ...side, projectId: ids.project.acmeShop });
      await t.vault.set(side.credentialRef, JSON.stringify({ token: 'sbp_side' }));
      const out = await t.app.grants.request({
        sessionId: ids.session.gemini,
        targetId: side.id,
        scope: ['write'],
        reason: 'seed staging',
        triggeredBy: 'mcp:request_access',
      });
      if (out.kind !== 'pending') throw new Error('expected pending');
      expect(out.grant.duration).toBe('1h');
      const g = await t.app.grants.approve(out.grant.id, 'session');
      expect(g.duration).toBe('session');
    });

    it('when the adapter narrows the credential, a production write keeps the duration the person picked', async () => {
      const t = makeTestApp();
      Object.assign(t.app.providers.get('supabase'), { issuesScoped: () => true });
      const out = await requestSupabase(t);
      if (out.kind !== 'pending') throw new Error('expected pending');
      expect(out.grant.duration).toBe('1h');
      expect(t.app.repos.pendingAsks.get(out.ask.id)?.payload).toMatchObject({ credentialScoped: true });
      const g = await t.app.grants.approve(out.grant.id, 'session');
      expect(g).toMatchObject({ duration: 'session', mfaVerified: true });
      expect(grantedRow(t, g.id)?.detail).toEqual({ decidedBy: 'user', mfaVerified: true });
    });

    /** A live grant on Supabase prod for read+write, as one issued before the cap could look. */
    const legacyGrant = (t: TestApp, duration: 'once' | '1h' | 'session' | 'always') => {
      const now = t.clock.now();
      const g = {
        ...fixtures.demoGrants()[0]!,
        id: fixtures.ids.grant.supabaseCodex,
        sessionId: duration === 'always' ? null : ids.session.gemini,
        targetId: ids.target.supabaseProd,
        scope: ['read' as const, 'write' as const],
        duration,
        state: 'active' as const,
        issuedAt: now,
        expiresAt: duration === '1h' || duration === 'once' ? now + HOUR : null,
        idleExpiresAt: null,
      };
      t.app.repos.grants.upsert(g);
      return g;
    };
    const policyRevoke = (t: TestApp, grantId: string) =>
      t.app.repos.audit.all().find((e) => e.grantId === grantId && e.action === 'revoked');

    it('a longer grant already on file (from before the cap) carries nothing, reads included; an unused once grant does', async () => {
      const t = makeTestApp();
      const target = t.app.repos.targets.get(ids.target.supabaseProd);
      if (!target) throw new Error('fixture target');
      for (const duration of ['1h', 'session', 'always'] as const) {
        legacyGrant(t, duration);
        expect(t.app.grants.covering(target, ids.session.gemini, ['write'])).toBeNull();
        // Its token is the whole token either way, so it does not carry a read either.
        expect(t.app.grants.covering(target, ids.session.gemini, ['read'])).toBeNull();
      }
      const once = legacyGrant(t, 'once');
      expect(t.app.grants.covering(target, ids.session.gemini, ['write'])?.id).toBe(once.id);
      // ...and a fresh request, a read included, is not short-circuited by a legacy `always` grant.
      legacyGrant(t, 'always');
      expect((await requestSupabase(t, ['write'])).kind).toBe('pending');
      expect((await requestSupabase(t, ['read'])).kind).toBe('pending');
    });

    it('fetching the credential of such a grant ends it (audited as a policy revoke) and refuses', async () => {
      const t = makeTestApp();
      const target = t.app.repos.targets.get(ids.target.supabaseProd);
      if (!target?.credentialRef) throw new Error('fixture target');
      await t.vault.set(target.credentialRef, JSON.stringify({ token: 'sbp_test' }));
      const g = legacyGrant(t, 'always');
      await expect(
        t.app.grants.credentialFor(g.id, { sessionId: ids.session.gemini, projectId: ids.project.acmeShop }),
      ).rejects.toMatchObject({ code: 'forbidden' });
      expect(t.app.repos.grants.get(g.id)).toMatchObject({ state: 'revoked', revokeReason: 'policy' });
      expect(policyRevoke(t, g.id)).toMatchObject({
        actorKind: 'system',
        triggeredBy: 'production writes on this target are approved one command at a time',
        detail: { reason: 'policy' },
      });
      expect(t.app.audit.verifyChain()).toMatchObject({ ok: true });
      // A read-only standing grant on the same target is untouched (reads keep the longer durations).
      const read = {
        ...legacyGrant(t, 'always'),
        id: fixtures.ids.grant.awsClaude,
        scope: ['read' as const],
      };
      t.app.repos.grants.upsert(read);
      await expect(t.app.grants.credentialFor(read.id)).resolves.toMatchObject({ kind: 'env' });
    });

    it('two different production commands each get their own request; the same command collapses onto one', async () => {
      const t = makeTestApp();
      const ask = (reason: string) =>
        t.app.grants.request({
          sessionId: ids.session.gemini,
          targetId: ids.target.supabaseProd,
          scope: ['write'],
          reason,
          triggeredBy: reason,
        });
      const a = await ask('$ supabase db push');
      const b = await ask('$ supabase db reset');
      const a2 = await ask('$ supabase db push');
      expect(b.grant.id).not.toBe(a.grant.id);
      expect(a2.grant.id).toBe(a.grant.id);
      // Not once-only (a read): different reasons still collapse, as before.
      const r1 = await requestSupabase(t, ['read']);
      const r2 = await t.app.grants.request({
        sessionId: ids.session.gemini,
        targetId: ids.target.supabaseProd,
        scope: ['read'],
        reason: 'something else',
        triggeredBy: 'mcp:request_access',
      });
      expect(r2.grant.id).toBe(r1.grant.id);
    });
  });
});

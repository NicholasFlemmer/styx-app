import { fixtures, targetDerivedState, tableFrom, type ReadModel, type ReadModelSnapshot } from '@styx/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestApp, type TestApp } from '../test-support';

const { ids } = fixtures;
const HOUR = 3_600_000;

const modelOf = (snap: ReadModelSnapshot): ReadModel => ({
  ...snap,
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

/** The idle Gemini session on acme-shop asks for Supabase prod (ask + MFA: prod ∧ write). */
async function requestSupabase(t: TestApp) {
  const target = t.app.repos.targets.get(ids.target.supabaseProd);
  if (!target?.credentialRef) throw new Error('fixture target');
  await t.vault.set(target.credentialRef, JSON.stringify({ token: 'sbp_test' }));
  return t.app.grants.request({
    sessionId: ids.session.gemini,
    targetId: ids.target.supabaseProd,
    scope: ['read', 'write'],
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
    const out = await requestSupabase(t);
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
      body: 'grant: supabase-prod · read+write · expires in 1h',
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

  it('revoke → revoked, credential dropped, audit revoked by you, target locked', async () => {
    const t = makeTestApp();
    const out = await requestSupabase(t);
    if (out.kind !== 'pending') throw new Error('expected pending');
    const g = await t.app.grants.approve(out.grant.id, 'session');
    expect(g.expiresAt).toBeNull();
    const r = t.app.grants.revoke(g.id);
    expect(r).toMatchObject({ state: 'revoked', revokeReason: 'user', revokedAt: t.clock.now() });
    expect(t.app.grants.issuedCredential(g.id)).toBeNull();
    expect(t.app.repos.grants.credNonce(g.id)).toBeNull();
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

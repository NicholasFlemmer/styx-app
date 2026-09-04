import { describe, expect, it } from 'vitest';
import { idFrom } from '../ids';
import type { GrantId, PolicyId, SessionId, TargetId } from '../ids';
import type { Duration, Env, Scope } from '../model/common';
import type { GrantState } from '../model/grant';
import {
  GRANT_EVENT_TYPES,
  GRANT_STATES,
  HOUR_MS,
  covers,
  expiresAtFor,
  idleExpiresAtFor,
  isLive,
  openUntil,
  requiresMfa,
  shouldExpire,
  transition,
} from './grant';
import type { GrantContext, GrantEvent, GrantEventType } from './grant';

const NOW = 1_700_000_000_000;
const grantId = idFrom<'GrantId'>('grant-1') as GrantId;
const sessionId = idFrom<'SessionId'>('sess-1') as SessionId;
const targetId = idFrom<'TargetId'>('tgt-1') as TargetId;
const policyId = idFrom<'PolicyId'>('pol-1') as PolicyId;

const ctx = (
  over: { env?: Env; scope?: Scope[]; duration?: Duration; session?: null; idleMs?: number | null } = {},
): GrantContext => ({
  now: NOW,
  grant: {
    id: grantId,
    sessionId,
    targetId,
    worktreeId: null,
    scope: over.scope ?? ['read'],
    duration: over.duration ?? '1h',
    reason: 'migration 0042',
    expiresAt: null,
    idleExpiresAt: null,
    policyId: null,
  },
  target: { env: over.env ?? 'staging', label: 'supabase-prod' },
  session:
    over.session === null
      ? null
      : { id: sessionId, agent: 'codex', label: 'codex · acme-shop', worktreeLabel: 'test/flaky' },
  projectId: null,
  idleMs: over.idleMs === undefined ? HOUR_MS : over.idleMs,
});

const ISSUE: Extract<GrantEvent, { type: 'issue' }> = {
  type: 'issue',
  decidedBy: 'user',
  duration: '1h',
  mfaVerified: true,
  policyId: null,
  idleMs: HOUR_MS,
  triggeredBy: 'grant sheet',
};

const EVENTS: Record<GrantEventType, GrantEvent> = {
  issue: ISSUE,
  deny: { type: 'deny', triggeredBy: 'grant sheet' },
  cancel: { type: 'cancel', reason: 'session-end' },
  use: { type: 'use', command: '$ supabase db push', scopeUsed: 'write' },
  revoke: { type: 'revoke', reason: 'user', triggeredBy: 'lock glyph' },
  expire: { type: 'expire', reason: 'idle' },
};

const EXPECTED: Record<GrantState, Record<GrantEventType, GrantState | null>> = {
  requested: { issue: 'active', deny: 'denied', cancel: 'revoked', use: null, revoke: null, expire: null },
  active: { issue: null, deny: null, cancel: null, use: 'active', revoke: 'revoked', expire: 'expired' },
  denied: { issue: null, deny: null, cancel: null, use: null, revoke: null, expire: null },
  revoked: { issue: null, deny: null, cancel: null, use: null, revoke: null, expire: null },
  expired: { issue: null, deny: null, cancel: null, use: null, revoke: null, expire: null },
};

describe('grant machine: every (state, event) pair', () => {
  const cases = GRANT_STATES.flatMap((state) =>
    GRANT_EVENT_TYPES.map((event) => ({ state, event, next: EXPECTED[state][event] })),
  );
  it.each(cases)('$state × $event → $next', ({ state, event, next }) => {
    const result = transition(state, EVENTS[event], ctx());
    if (next === null) expect(result).toBeNull();
    else expect(result?.state).toBe(next);
  });
  it('covers the full table', () => {
    expect(cases).toHaveLength(GRANT_STATES.length * GRANT_EVENT_TYPES.length);
  });
});

describe('requiresMfa', () => {
  it.each([
    ['prod', ['write'], true],
    ['prod', ['deploy'], true],
    ['prod', ['delete'], true],
    ['prod', ['read', 'write'], true],
    ['prod', ['read'], false],
    ['staging', ['write'], false],
    ['preview', ['deploy'], false],
    ['scm', ['delete'], false],
  ] as const)('%s %j → %s', (env, scopes, expected) => {
    expect(requiresMfa(env, scopes)).toBe(expected);
  });
});

describe('issue', () => {
  it('prod write without MFA is invalid', () => {
    expect(
      transition(
        'requested',
        { ...ISSUE, mfaVerified: false },
        ctx({ env: 'prod', scope: ['read', 'write'] }),
      ),
    ).toBeNull();
  });

  it('prod write with MFA issues a 1h grant with expiry + idle timers, audit, ask resolution and notification', () => {
    const r = transition('requested', EVENTS.issue, ctx({ env: 'prod', scope: ['read', 'write'] }));
    expect(r?.state).toBe('active');
    expect(r?.patch).toEqual({
      duration: '1h',
      issuedAt: NOW,
      expiresAt: NOW + HOUR_MS,
      idleExpiresAt: NOW + HOUR_MS,
      policyId: null,
      mfaVerified: true,
      decidedBy: 'user',
    });
    expect(r?.effects.map((e) => e.type)).toEqual([
      'issueCredential',
      'startExpiryTimer',
      'startIdleTimer',
      'appendAudit',
      'resolveAsk',
      'notify',
    ]);
    const audit = r?.effects.find((e) => e.type === 'appendAudit');
    expect(audit?.type === 'appendAudit' && audit.entry).toMatchObject({
      action: 'granted',
      actorKind: 'you',
      actorLabel: 'you',
      agent: 'codex',
      scope: ['read', 'write'],
      duration: '1h',
      triggeredBy: 'grant sheet',
      targetLabel: 'supabase-prod',
      sessionLabel: 'codex · acme-shop',
      worktreeLabel: 'test/flaky',
      detail: { decidedBy: 'user', mfaVerified: true },
    });
  });

  it('prod read needs no MFA', () => {
    expect(
      transition('requested', { ...ISSUE, mfaVerified: false }, ctx({ env: 'prod', scope: ['read'] }))?.state,
    ).toBe('active');
  });

  it('policy auto-issue is audited as system with the policy id', () => {
    const r = transition(
      'requested',
      { ...ISSUE, decidedBy: 'policy', policyId, triggeredBy: 'mcp:request_access' },
      ctx(),
    );
    const audit = r?.effects.find((e) => e.type === 'appendAudit');
    expect(audit?.type === 'appendAudit' && audit.entry).toMatchObject({
      actorKind: 'system',
      policyId,
      triggeredBy: 'mcp:request_access',
    });
    expect(r?.patch.policyId).toBe(policyId);
  });

  it('always never expires: no timers, session detached', () => {
    const r = transition('requested', { ...ISSUE, duration: 'always' }, ctx());
    expect(r?.patch).toMatchObject({
      duration: 'always',
      expiresAt: null,
      idleExpiresAt: null,
      sessionId: null,
    });
    expect(r?.effects.map((e) => e.type)).toEqual([
      'issueCredential',
      'detachSession',
      'appendAudit',
      'resolveAsk',
      'notify',
    ]);
  });

  it('session duration: no hard expiry, idle timer only', () => {
    const r = transition('requested', { ...ISSUE, duration: 'session' }, ctx());
    expect(r?.patch).toMatchObject({ expiresAt: null, idleExpiresAt: NOW + HOUR_MS });
    expect(r?.effects.map((e) => e.type)).toEqual([
      'issueCredential',
      'startIdleTimer',
      'appendAudit',
      'resolveAsk',
      'notify',
    ]);
  });

  it('no idle policy: no idle timer', () => {
    const r = transition('requested', { ...ISSUE, idleMs: null }, ctx());
    expect(r?.patch.idleExpiresAt).toBeNull();
    expect(r?.effects.some((e) => e.type === 'startIdleTimer')).toBe(false);
  });

  it('no session (shim without a session): no notify, audit has no session labels', () => {
    const r = transition('requested', EVENTS.issue, ctx({ session: null }));
    expect(r?.effects.some((e) => e.type === 'notify')).toBe(false);
    const audit = r?.effects.find((e) => e.type === 'appendAudit');
    expect(audit?.type === 'appendAudit' && audit.entry).toMatchObject({
      sessionId: null,
      sessionLabel: null,
      worktreeLabel: null,
      agent: null,
    });
  });
});

describe('deny / cancel', () => {
  it('deny is audited as you, resolves the ask and notifies the session', () => {
    const r = transition('requested', EVENTS.deny, ctx());
    expect(r?.patch).toEqual({ revokedAt: NOW });
    expect(r?.effects.map((e) => e.type)).toEqual(['appendAudit', 'resolveAsk', 'notify']);
    expect(r?.effects[1]).toEqual({ type: 'resolveAsk', grantId, outcome: 'denied' });
  });
  it('deny without a session does not notify', () => {
    expect(transition('requested', EVENTS.deny, ctx({ session: null }))?.effects.map((e) => e.type)).toEqual([
      'appendAudit',
      'resolveAsk',
    ]);
  });
  it('cancel on session end revokes the request and cancels the ask', () => {
    const r = transition('requested', EVENTS.cancel, ctx());
    expect(r?.patch).toEqual({ revokedAt: NOW, revokeReason: 'session-end' });
    expect(r?.effects[1]).toEqual({ type: 'resolveAsk', grantId, outcome: 'cancelled' });
  });
});

describe('use', () => {
  it('re-arms the idle timer and audits the use with the triggering command', () => {
    const r = transition('active', EVENTS.use, ctx());
    expect(r?.state).toBe('active');
    expect(r?.patch).toEqual({ lastUsedAt: NOW, idleExpiresAt: NOW + HOUR_MS });
    expect(r?.effects.map((e) => e.type)).toEqual(['appendAudit', 'startIdleTimer']);
    const audit = r?.effects[0];
    expect(audit?.type === 'appendAudit' && audit.entry).toMatchObject({
      action: 'used',
      actorKind: 'agent',
      actorLabel: 'codex · acme-shop',
      scope: ['write'],
      triggeredBy: '$ supabase db push',
      detail: { via: 'shim' },
    });
  });
  it('get_credential use has no command', () => {
    const r = transition('active', { type: 'use', command: null, scopeUsed: 'read' }, ctx({ session: null }));
    const audit = r?.effects[0];
    expect(audit?.type === 'appendAudit' && audit.entry).toMatchObject({
      actorKind: 'system',
      triggeredBy: null,
      detail: { via: 'get_credential' },
    });
  });
  it('always grants have no idle timer on use', () => {
    const r = transition('active', EVENTS.use, ctx({ duration: 'always' }));
    expect(r?.patch).toEqual({ lastUsedAt: NOW, idleExpiresAt: null });
    expect(r?.effects.map((e) => e.type)).toEqual(['appendAudit']);
  });
  it('once is revoked after first use', () => {
    const r = transition('active', EVENTS.use, ctx({ duration: 'once' }));
    expect(r?.state).toBe('revoked');
    expect(r?.patch).toEqual({ lastUsedAt: NOW, revokedAt: NOW, revokeReason: 'once-used' });
    expect(r?.effects.map((e) => e.type)).toEqual([
      'appendAudit',
      'revokeCredential',
      'cancelTimers',
      'appendAudit',
    ]);
    const revoked = r?.effects[3];
    expect(revoked?.type === 'appendAudit' && revoked.entry).toMatchObject({
      action: 'revoked',
      actorKind: 'system',
      detail: { reason: 'once-used' },
    });
  });
});

describe('revoke / expire', () => {
  it('user revoke from a lock glyph', () => {
    const r = transition('active', EVENTS.revoke, ctx());
    expect(r?.patch).toEqual({ revokedAt: NOW, revokeReason: 'user' });
    expect(r?.effects.map((e) => e.type)).toEqual(['revokeCredential', 'cancelTimers', 'appendAudit']);
    const audit = r?.effects[2];
    expect(audit?.type === 'appendAudit' && audit.entry).toMatchObject({
      action: 'revoked',
      actorKind: 'you',
      triggeredBy: 'lock glyph',
    });
  });
  it('session-end revoke is a system action', () => {
    const r = transition(
      'active',
      { type: 'revoke', reason: 'session-end', triggeredBy: 'session end' },
      ctx(),
    );
    const audit = r?.effects[2];
    expect(audit?.type === 'appendAudit' && audit.entry).toMatchObject({
      actorKind: 'system',
      detail: { reason: 'session-end' },
    });
  });
  it.each([
    ['idle', 'idle timer'],
    ['expired', 'expiry timer'],
  ] as const)('expire(%s) → expired, audited as %s', (reason, triggeredBy) => {
    const r = transition('active', { type: 'expire', reason }, ctx());
    expect(r?.state).toBe('expired');
    expect(r?.patch).toEqual({ revokedAt: NOW, revokeReason: reason });
    const audit = r?.effects[2];
    expect(audit?.type === 'appendAudit' && audit.entry).toMatchObject({
      action: 'expired',
      actorKind: 'system',
      triggeredBy,
      detail: { reason },
    });
  });
  it('always never expires', () => {
    expect(transition('active', EVENTS.expire, ctx({ duration: 'always' }))).toBeNull();
    expect(
      transition('active', { type: 'expire', reason: 'expired' }, ctx({ duration: 'always' })),
    ).toBeNull();
  });
});

describe('time helpers', () => {
  it('expiresAtFor', () => {
    expect(expiresAtFor('once', NOW)).toBe(NOW + HOUR_MS);
    expect(expiresAtFor('1h', NOW)).toBe(NOW + HOUR_MS);
    expect(expiresAtFor('session', NOW)).toBeNull();
    expect(expiresAtFor('always', NOW)).toBeNull();
  });
  it('idleExpiresAtFor', () => {
    expect(idleExpiresAtFor('1h', HOUR_MS, NOW)).toBe(NOW + HOUR_MS);
    expect(idleExpiresAtFor('1h', null, NOW)).toBeNull();
    expect(idleExpiresAtFor('always', HOUR_MS, NOW)).toBeNull();
  });
  it('openUntil = min(expiresAt, idleExpiresAt), null when persistent', () => {
    expect(openUntil({ expiresAt: 10, idleExpiresAt: 5 })).toBe(5);
    expect(openUntil({ expiresAt: 5, idleExpiresAt: 10 })).toBe(5);
    expect(openUntil({ expiresAt: null, idleExpiresAt: 7 })).toBe(7);
    expect(openUntil({ expiresAt: 7, idleExpiresAt: null })).toBe(7);
    expect(openUntil({ expiresAt: null, idleExpiresAt: null })).toBeNull();
  });
  it('shouldExpire', () => {
    expect(shouldExpire({ state: 'active', duration: '1h', expiresAt: NOW, idleExpiresAt: null }, NOW)).toBe(
      'expired',
    );
    expect(
      shouldExpire({ state: 'active', duration: '1h', expiresAt: NOW + 1, idleExpiresAt: NOW }, NOW),
    ).toBe('idle');
    expect(
      shouldExpire({ state: 'active', duration: '1h', expiresAt: NOW + 1, idleExpiresAt: NOW + 1 }, NOW),
    ).toBeNull();
    expect(
      shouldExpire({ state: 'active', duration: 'session', expiresAt: null, idleExpiresAt: null }, NOW),
    ).toBeNull();
    expect(
      shouldExpire({ state: 'active', duration: 'always', expiresAt: NOW - 1, idleExpiresAt: NOW - 1 }, NOW),
    ).toBeNull();
    expect(
      shouldExpire({ state: 'revoked', duration: '1h', expiresAt: NOW - 1, idleExpiresAt: null }, NOW),
    ).toBeNull();
  });
  it('covers / isLive', () => {
    expect(covers({ state: 'active', scope: ['read', 'write'] }, ['read'])).toBe(true);
    expect(covers({ state: 'active', scope: ['read'] }, ['read', 'write'])).toBe(false);
    expect(covers({ state: 'requested', scope: ['read'] }, ['read'])).toBe(false);
    expect(isLive({ state: 'active', expiresAt: null, idleExpiresAt: null }, NOW)).toBe(true);
    expect(isLive({ state: 'active', expiresAt: NOW + 1, idleExpiresAt: null }, NOW)).toBe(true);
    expect(isLive({ state: 'active', expiresAt: NOW, idleExpiresAt: null }, NOW)).toBe(false);
    expect(isLive({ state: 'expired', expiresAt: NOW + 1, idleExpiresAt: null }, NOW)).toBe(false);
  });
});

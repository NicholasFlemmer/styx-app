import { describe, expect, it } from 'vitest';
import { idFrom } from '../ids';
import type { GrantId } from '../ids';
import { DEMO_NOW, demoReadModel, errorReadModel, ids } from '../fixtures/demo';
import type { AuditEntry } from '../model/audit';
import type { Grant } from '../model/grant';
import type { PendingAsk } from '../model/session';
import type { ReadModel } from '../read-model';
import { removeRows, rows, upsertRows } from '../read-model';
import { auditDetailRows, auditRow, auditRows, auditWhat, canRevokeFromAudit } from './audit';
import { headlineScope, inboxRows, inboxTabLabel, inboxTargetLabel, toastFor } from './inbox';
import { DEPLOYABLE_PROVIDERS, flattenPalette, nextPaletteScope, paletteResults } from './palette';

const NOW = DEMO_NOW;
const MIN = 60_000;

describe('auditRows (prototype audit log)', () => {
  const model = demoReadModel();
  it('renders the prototype rows newest first', () => {
    expect(auditRows(model, NOW).map((r) => `${r.t} ${r.who} ${r.target} ${r.what}`)).toEqual([
      '09:41 Claude vercel-prod used deploy token (auto: policy #1)',
      '09:12 you vercel-prod granted deploy to Claude · 1h',
      '08:58 system aws-acme-prod revoked Gemini grant · idle 1h',
      '08:30 Cursor github opened PR #212',
    ]);
  });
  it('a row within the last minute reads "now"', () => {
    const entries = rows(model.auditEntries);
    const granted = entries.find((e) => e.action === 'granted') as AuditEntry;
    const fresh: AuditEntry = {
      ...granted,
      id: idFrom<'AuditId'>('a-now'),
      seq: 99,
      time: NOW - 5_000,
      agent: 'codex',
      scope: ['read', 'write'],
      targetLabel: 'supabase-prod',
    };
    expect(auditRow({ ...fresh, targetLabel: null }, rows(model.policies), NOW).target).toBe('—');
    expect(auditRow(fresh, rows(model.policies), NOW)).toMatchObject({
      t: 'now',
      who: 'you',
      what: 'granted read+write to Codex · 1h',
    });
  });
  it('every action kind has a label', () => {
    const base = rows(model.auditEntries).find((e) => e.action === 'used') as AuditEntry;
    const policies = rows(model.policies);
    const at = (over: Partial<AuditEntry>): string => auditWhat({ ...base, ...over }, policies);
    expect(at({ policyId: null })).toBe('used deploy token');
    expect(at({ action: 'denied', scope: ['write'] })).toBe('denied write to Claude');
    expect(at({ action: 'requested', scope: ['read', 'write'] })).toBe('requested read+write');
    expect(at({ action: 'revoked', detail: { reason: 'user' } })).toBe(
      'revoked Claude grant · revoked by you',
    );
    expect(at({ action: 'revoked', detail: {}, triggeredBy: 'lock glyph' })).toBe(
      'revoked Claude grant · lock glyph',
    );
    expect(at({ action: 'revoked', detail: {}, triggeredBy: null })).toBe('revoked Claude grant · —');
    expect(at({ action: 'revoked', detail: { reason: 'not-a-reason' }, triggeredBy: null })).toBe(
      'revoked Claude grant · —',
    );
    expect(at({ action: 'expired', detail: { reason: 'expired' }, agent: null, actorLabel: 'system' })).toBe(
      'revoked system grant · expired',
    );
    expect(at({ action: 'granted', duration: null })).toBe('granted deploy to Claude · —');
    expect(at({ action: 'granted', scope: null })).toBe('granted  to Claude · 1h');
    expect(at({ action: 'merged-pr', detail: { prNumber: '7' } })).toBe('merged PR #7');
    expect(at({ action: 'opened-pr', detail: {} })).toBe('opened PR #?');
    expect(at({ action: 'connected' })).toBe('connected');
    expect(at({ action: 'disconnected' })).toBe('disconnected');
    expect(at({ action: 'tested' })).toBe('tested connection');
    expect(at({ action: 'policy-changed' })).toBe('changed policies');
    expect(at({ action: 'exported' })).toBe('exported audit log');
  });
  it('detail rows for the drawer', () => {
    const policies = rows(model.policies);
    const granted = rows(model.auditEntries).find((e) => e.action === 'granted') as AuditEntry;
    expect(auditDetailRows(granted, policies).map((r) => [r.k, r.v])).toEqual([
      ['Actor', 'you'],
      ['Target', 'vercel-prod'],
      ['Scope', 'deploy'],
      ['Duration', '1h · expires 10:12'],
      ['Session', 'claude · acme-shop'],
      ['Worktree', 'fix/checkout'],
      ['Triggered by', 'grant sheet'],
      ['Policy', '#2 ask + MFA'],
    ]);
    const used = rows(model.auditEntries).find((e) => e.action === 'used') as AuditEntry;
    expect(auditDetailRows(used, policies).map((r) => r.v)).toEqual([
      'Claude',
      'vercel-prod',
      'deploy',
      'policy · single use',
      'claude · acme-shop',
      'fix/checkout',
      '$ vercel deploy --prod',
      '#1 auto-approve staging reads',
    ]);
    const expired = rows(model.auditEntries).find((e) => e.action === 'expired') as AuditEntry;
    expect(auditDetailRows(expired, policies).map((r) => r.v)).toEqual([
      'system',
      'aws-acme-prod',
      'read',
      '—',
      'gemini · acme-shop',
      'main',
      'idle timer',
      '#3 idle expiry',
    ]);
    const custom = policies.map((p) => ({ ...p, builtinKey: null, ruleText: 'Deny deploys after 18:00' }));
    expect(auditDetailRows(granted, custom)[7]?.v).toBe('#2 Deny deploys after 18:00');
    const bare: AuditEntry = {
      ...used,
      action: 'used',
      policyId: null,
      scope: null,
      sessionLabel: null,
      worktreeLabel: null,
      triggeredBy: null,
      targetLabel: null,
      duration: null,
    };
    expect(auditDetailRows(bare, policies).map((r) => r.v)).toEqual([
      'Claude',
      '—',
      '—',
      '—',
      '—',
      '—',
      '—',
      '—',
    ]);
    const sessionGrant: AuditEntry = { ...granted, duration: 'session' };
    expect(auditDetailRows(sessionGrant, policies)[3]?.v).toBe('session');
  });
  it('Revoke now is enabled only for active user-issued grants', () => {
    const entries = rows(model.auditEntries);
    const granted = entries.find((e) => e.action === 'granted') as AuditEntry;
    const expired = entries.find((e) => e.action === 'expired') as AuditEntry;
    const opened = entries.find((e) => e.action === 'opened-pr') as AuditEntry;
    expect(canRevokeFromAudit(granted, model)).toBe(true);
    expect(canRevokeFromAudit(expired, model)).toBe(false);
    expect(canRevokeFromAudit(opened, model)).toBe(false);
    expect(canRevokeFromAudit({ ...granted, grantId: idFrom<'GrantId'>('nope') as GrantId }, model)).toBe(
      false,
    );
    const g = model.grants.byId[ids.grant.vercelProdClaude] as Grant;
    const systemIssued = {
      ...model,
      grants: upsertRows(model.grants, [{ ...g, decidedBy: 'policy' as const }]),
    };
    expect(canRevokeFromAudit(granted, systemIssued)).toBe(false);
  });
});

describe('inbox', () => {
  const model = demoReadModel();
  it('three requests, newest first, with env/scope/reason/age', () => {
    expect(
      inboxRows(model, NOW).map((r) => [
        r.agent,
        r.project,
        r.target,
        r.env,
        r.prod,
        r.scope,
        r.reason,
        r.age,
      ]),
    ).toEqual([
      ['Codex', 'acme-shop', 'Supabase prod', 'prod', true, 'write', 'migration 0042', '3m'],
      ['Claude', 'infra-tools', 'AWS acme-prod', 'prod', true, 'read', 'list ECS services', '9m'],
      ['Cursor', 'blog-v2', 'Vercel', 'preview', false, 'deploy', 'preview deploy for #88', '14m'],
    ]);
    expect(inboxRows(model, NOW)[0]?.scopes).toEqual(['read', 'write']);
    expect(inboxTabLabel(model, NOW)).toBe('Inbox · 3');
  });
  it('headline scope and target label', () => {
    expect(headlineScope(['read', 'delete'])).toBe('delete');
    expect(headlineScope([])).toBe('');
    expect(inboxTargetLabel({ name: 'Supabase', provider: 'supabase', env: 'staging' })).toBe('Supabase');
    expect(inboxTargetLabel({ name: 'Supabase', provider: 'supabase', env: 'prod' })).toBe('Supabase prod');
    expect(inboxTargetLabel({ name: 'AWS acme-prod', provider: 'aws', env: 'prod' })).toBe('AWS acme-prod');
  });
  it('drops requests whose target is gone; no session → —', () => {
    const noTarget = { ...model, targets: removeRows(model.targets, [ids.target.infraAws]) };
    expect(inboxRows(noTarget, NOW)).toHaveLength(2);
    const g = model.grants.byId[ids.grant.awsClaude] as Grant;
    const detached = { ...model, grants: upsertRows(model.grants, [{ ...g, sessionId: null }]) };
    expect(inboxRows(detached, NOW)[1]?.agent).toBe('—');
  });
  it('toast copy for the Codex request', () => {
    expect(toastFor(model, ids.grant.supabaseCodex)).toEqual({
      header: 'Needs you',
      source: 'Styx · now',
      title: 'Codex wants Supabase prod · write',
      meta: 'acme-shop · test/flaky · "migration 0042"',
      review: 'Review',
      later: 'Later',
    });
    expect(toastFor(model, ids.grant.awsClaude)?.title).toBe('Claude wants AWS acme-prod prod · read');
  });
  it('toast is null without a grant, session or target', () => {
    expect(toastFor(model, idFrom<'GrantId'>('nope') as GrantId)).toBeNull();
    expect(toastFor(model, ids.grant.vercelPreviewAlways)).toBeNull();
    expect(
      toastFor(
        { ...model, sessions: removeRows(model.sessions, [ids.session.codex]) },
        ids.grant.supabaseCodex,
      ),
    ).toBeNull();
    expect(
      toastFor(
        { ...model, targets: removeRows(model.targets, [ids.target.supabaseProd]) },
        ids.grant.supabaseCodex,
      ),
    ).toBeNull();
  });
});

describe('paletteResults', () => {
  const model = demoReadModel();
  const ui = { projectId: ids.project.acmeShop };
  const flat = (m: ReadModel, q = '', scope: 'all' | 'actions' | 'agents' | 'projects' = 'all') =>
    flattenPalette(paletteResults(m, ui, q, scope, NOW)).map((i) => `${i.glyph} ${i.label} · ${i.meta}`);

  it('groups Actions / Agents / Projects with the prototype rows and lock state in meta', () => {
    const groups = paletteResults(model, ui, '', 'all', NOW);
    expect(groups.map((g) => g.label)).toEqual(['Actions', 'Agents', 'Projects']);
    expect(groups[0]?.items.map((i) => `${i.glyph} ${i.label} · ${i.meta}`)).toEqual([
      '▲ Deploy acme-shop → Vercel prod · open · 58m',
      '▲ Deploy acme-shop → Vercel preview · always',
      '◆ Grant Codex → Supabase prod · needs you',
      '+ Spawn agent in acme-shop · claude ▾',
      '■ New project… · empty · template · agent',
    ]);
    expect(groups[1]?.items.map((i) => `${i.glyph} ${i.label} · ${i.meta}`)).toEqual([
      '● Claude · acme-shop · working',
      '● Codex · acme-shop · needs you',
      '● Claude · blog-v2 · needs you',
      '● Gemini · acme-shop · idle',
      '● Gemini · infra-tools · working',
      '● shell · client-x · working',
    ]);
    expect(groups[2]?.items.map((i) => `${i.label} · ${i.meta}`)).toEqual([
      'Switch to acme-shop · fix/checkout',
      'Switch to blog-v2 · feat/mdx',
      'Switch to infra-tools · main',
      'Switch to client-x · main',
      'Switch to side-api · main',
    ]);
    const all = flattenPalette(groups);
    expect(all.filter((i) => i.first).map((i) => i.label)).toEqual(['Deploy acme-shop → Vercel prod']);
    expect(all[0]?.action).toEqual({
      kind: 'deploy',
      projectId: ids.project.acmeShop,
      targetId: ids.target.vercelProd,
    });
    expect(all[2]?.action).toEqual({
      kind: 'review-ask',
      sessionId: ids.session.codex,
      askId: ids.ask.codexGrant,
    });
    expect(all[3]?.action).toEqual({ kind: 'spawn', projectId: ids.project.acmeShop });
    expect(all[4]?.action).toEqual({ kind: 'new-project' });
    expect(all[5]?.action).toEqual({ kind: 'open-session', sessionId: ids.session.claude });
    expect(all[11]?.action).toEqual({ kind: 'switch-project', projectId: ids.project.acmeShop });
  });

  it('fuzzy on label + meta, best first; the first visible row is flagged; empty groups dropped', () => {
    const results = paletteResults(model, ui, 'supa', 'all', NOW);
    expect(results.map((g) => g.label)).toEqual(['Actions']);
    expect(results[0]?.items.map((i) => [i.label, i.first])).toEqual([['Grant Codex → Supabase prod', true]]);
    expect(flat(model, 'needs you')).toEqual([
      '◆ Grant Codex → Supabase prod · needs you',
      '● Codex · acme-shop · needs you',
      '● Claude · blog-v2 · needs you',
    ]);
    expect(flat(model, 'blog')[0]).toBe('● Claude · blog-v2 · needs you');
    expect(paletteResults(model, ui, 'zzzz', 'all', NOW)).toEqual([]);
  });

  it('scope filtering (⇥) and scope cycling', () => {
    expect(paletteResults(model, ui, '', 'agents', NOW).map((g) => g.label)).toEqual(['Agents']);
    expect(paletteResults(model, ui, '', 'projects', NOW)[0]?.items[0]?.first).toBe(true);
    expect(flat(model, '', 'actions')).toHaveLength(5);
    expect(nextPaletteScope('all')).toBe('actions');
    expect(nextPaletteScope('actions')).toBe('agents');
    expect(nextPaletteScope('agents')).toBe('projects');
    expect(nextPaletteScope('projects')).toBe('all');
  });

  it('without a current project only New project… remains in Actions', () => {
    expect(
      paletteResults(model, { projectId: null }, '', 'actions', NOW)[0]?.items.map((i) => i.label),
    ).toEqual(['New project…']);
  });

  it('lock state meta: locked / expired / unconnected, and after the grant', () => {
    const vercelProd = model.targets.byId[ids.target.vercelProd] as NonNullable<
      (typeof model.targets.byId)[string]
    >;
    const locked = { ...model, grants: removeRows(model.grants, [ids.grant.vercelProdClaude]) };
    expect(flat(locked, 'vercel prod', 'actions')[0]).toBe('▲ Deploy acme-shop → Vercel prod · locked');
    const expired = {
      ...locked,
      targets: upsertRows(model.targets, [{ ...vercelProd, health: 'expired' as const }]),
    };
    expect(flat(expired, 'vercel prod', 'actions')[0]).toBe('▲ Deploy acme-shop → Vercel prod · expired');
    const unconnected = {
      ...locked,
      targets: upsertRows(model.targets, [{ ...vercelProd, credentialRef: null }]),
    };
    expect(flat(unconnected, 'vercel prod', 'actions')[0]).toBe(
      '▲ Deploy acme-shop → Vercel prod · unconnected',
    );
    expect(DEPLOYABLE_PROVIDERS).toContain('vercel');
    expect(flat(errorReadModel(), 'deploy', 'actions')).toHaveLength(2);
  });

  it('grant rows need a grant head ask with a known grant and target', () => {
    const ask = model.pendingAsks.byId[ids.ask.codexGrant] as PendingAsk;
    const planAsk: PendingAsk = {
      ...ask,
      kind: 'plan',
      grantId: null,
      payload: { kind: 'plan', summary: '', files: [] },
    };
    expect(
      flat({ ...model, pendingAsks: upsertRows(model.pendingAsks, [planAsk]) }, 'grant codex', 'actions'),
    ).toEqual([]);
    expect(
      flat(
        { ...model, pendingAsks: removeRows(model.pendingAsks, [ids.ask.codexGrant]) },
        'grant codex',
        'actions',
      ),
    ).toEqual([]);
    expect(
      flat(
        { ...model, grants: removeRows(model.grants, [ids.grant.supabaseCodex]) },
        'grant codex',
        'actions',
      ),
    ).toEqual([]);
    expect(
      flat(
        { ...model, targets: removeRows(model.targets, [ids.target.supabaseProd]) },
        'grant codex',
        'actions',
      ),
    ).toEqual([]);
  });

  it('open meta counts down from the target open-until', () => {
    expect(flat(model, 'vercel prod', 'actions')[0]).toBe('▲ Deploy acme-shop → Vercel prod · open · 58m');
    expect(flat(model, 'vercel prod', 'actions').length).toBeGreaterThan(0);
    expect(paletteResults(model, ui, 'vercel prod', 'actions', NOW + 57 * MIN)[0]?.items[0]?.meta).toBe(
      'open · 1m',
    );
  });
});

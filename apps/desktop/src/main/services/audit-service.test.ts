import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate';
import { AuditService } from './audit-service';

function svc() {
  const db = new Database(':memory:');
  migrate(db);
  let t = 1_800_000_000_000;
  return { db, audit: new AuditService(db, () => (t += 1000)) };
}

describe('AuditService', () => {
  it('appends hash-chained rows and verifies the chain', () => {
    const { audit } = svc();
    const a = audit.append({
      actorKind: 'you',
      actorLabel: 'you',
      action: 'granted',
      triggeredBy: 'grant sheet',
      scope: ['read', 'write'],
      duration: '1h',
      targetLabel: 'supabase-prod',
    });
    const b = audit.append({
      actorKind: 'agent',
      actorLabel: 'Codex',
      action: 'used',
      triggeredBy: '$ supabase db push',
      grantId: a.grantId ?? null,
    });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(b.prevHash).toBe(a.hash);
    expect(audit.verifyChain()).toEqual({ ok: true, count: 2 });
    expect(audit.list().map((r) => r.seq)).toEqual([2, 1]);
    expect(audit.get(a.id)?.scopeJson).toBe('["read","write"]');
  });

  it('detects tampering (via a raw insert with a bad hash)', () => {
    const { db, audit } = svc();
    audit.append({ actorKind: 'system', actorLabel: 'system', action: 'revoked', triggeredBy: 'idle timer' });
    db.prepare(
      "INSERT INTO audit_entries (id, seq, time, actor_kind, actor_label, action, triggered_by, prev_hash, hash) VALUES ('x', 2, 0, 'you', 'you', 'denied', 'sheet', 'bogus', 'bogus')",
    ).run();
    expect(audit.verifyChain()).toEqual({ ok: false, brokenAtSeq: 2 });
  });

  it('exports JSON with the chain head', () => {
    const { audit } = svc();
    const r = audit.append({
      actorKind: 'you',
      actorLabel: 'you',
      action: 'exported',
      triggeredBy: 'settings',
    });
    const out = JSON.parse(audit.exportJson()) as { chainHead: string; entries: { id: string }[] };
    expect(out.chainHead).toBe(r.hash);
    expect(out.entries[0]?.id).toBe(r.id);
  });
});

describe('AuditService redaction', () => {
  it('redacts secret shapes in free-text fields before hashing so they never enter the chain (M1)', () => {
    const { audit } = svc();
    const ghp = `ghp_${'b'.repeat(36)}`;
    const row = audit.append({
      actorKind: 'agent',
      actorLabel: 'Codex',
      action: 'used',
      triggeredBy: `$ gh auth login --with-token ${ghp}`,
      targetLabel: `label ${ghp}`,
      sessionLabel: `session ${ghp}`,
      worktreeLabel: `wt ${ghp}`,
      detail: { reason: `use ${ghp}`, token: 'plain', nested: { accessKey: 'AKIAABCDEFGHIJKLMNOP' } },
    });
    const dumped = JSON.stringify(audit.get(row.id));
    expect(dumped).not.toContain(ghp);
    expect(dumped).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(dumped).not.toContain('plain');
    expect(row.triggeredBy).toBe('$ gh auth login --with-token [redacted]');
    expect(row.targetLabel).toBe('label [redacted]');
    expect(JSON.parse(row.detailJson ?? '{}')).toEqual({
      reason: 'use [redacted]',
      token: '[redacted]',
      nested: { accessKey: '[redacted]' },
    });
    expect(audit.verifyChain()).toEqual({ ok: true, count: 1 });
  });
});

import { describe, expect, it } from 'vitest';
import { auditEntrySchema } from '../model/audit';
import { cliInstallSchema, ideInstallSchema } from '../model/discovery';
import { grantSchema } from '../model/grant';
import { agentChangeSchema } from '../model/hunk';
import { notificationSchema } from '../model/notification';
import { policySchema } from '../model/policy';
import { projectSchema, repoSchema, worktreeSchema } from '../model/project';
import { pendingAskSchema, sessionSchema, transcriptMessageSchema } from '../model/session';
import { targetSchema } from '../model/target';
import { headAsk } from '../machines/session';
import {
  DEMO_NOW,
  demoFixture,
  demoReadModel,
  emptyFixture,
  emptyReadModel,
  errorFixture,
  errorReadModel,
  ids,
} from './demo';

describe('demo fixture', () => {
  const f = demoFixture();

  it('validates every row against its zod schema', () => {
    const check = <T>(
      schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } },
      list: T[],
    ): void => {
      for (const row of list) {
        const r = schema.safeParse(row);
        if (!r.success) throw new Error(JSON.stringify(r.error, null, 2));
      }
    };
    check(projectSchema, f.projects);
    check(repoSchema, f.repos);
    check(worktreeSchema, f.worktrees);
    check(sessionSchema, f.sessions);
    check(targetSchema, f.targets);
    check(grantSchema, f.grants);
    check(pendingAskSchema, f.pendingAsks);
    check(policySchema, f.policies);
    check(auditEntrySchema, f.auditEntries);
    check(transcriptMessageSchema, Object.values(f.transcripts).flat());
    check(agentChangeSchema, Object.values(f.hunks).flat());
    check(notificationSchema, f.notifications);
    check(ideInstallSchema, f.ides);
    check(cliInstallSchema, f.clis);
  });

  it('matches the prototype dataset shape', () => {
    expect(f.projects.map((p) => [p.name, p.initials, p.path])).toEqual([
      ['acme-shop', 'AS', '~/code/acme-shop'],
      ['blog-v2', 'BL', '~/code/blog-v2'],
      ['infra-tools', 'IN', '~/code/infra-tools'],
      ['client-x', 'CX', '~/work/client-x'],
      ['side-api', 'SA', '~/code/side-api'],
    ]);
    expect(f.sessions).toHaveLength(8);
    expect(f.sessions.map((s) => s.state)).toEqual([
      'working',
      'needs-you',
      'needs-you',
      'idle',
      'working',
      'working',
      'done',
      'done',
    ]);
    expect(f.targets.filter((t) => t.projectId === ids.project.acmeShop)).toHaveLength(5);
    expect(f.policies).toHaveLength(3);
    expect(f.auditEntries).toHaveLength(5);
    expect(f.hunks[ids.session.claude]).toHaveLength(3);
    expect(f.activity).toHaveLength(6);
    expect(f.now).toBe(DEMO_NOW);
  });

  it('references resolve: every session has a worktree and project; grants point at targets', () => {
    const wt = new Set(f.worktrees.map((w) => w.id));
    const pj = new Set(f.projects.map((p) => p.id));
    const tg = new Set(f.targets.map((t) => t.id));
    expect(f.sessions.every((s) => wt.has(s.worktreeId) && pj.has(s.projectId))).toBe(true);
    expect(f.grants.every((g) => tg.has(g.targetId))).toBe(true);
    expect(f.pendingAsks.every((a) => f.sessions.some((s) => s.id === a.sessionId))).toBe(true);
  });

  it('the Codex session has one open grant ask for Supabase prod read+write "migration 0042"', () => {
    const ask = headAsk(f.pendingAsks.filter((a) => a.sessionId === ids.session.codex));
    expect(ask?.grantId).toBe(ids.grant.supabaseCodex);
    const grant = f.grants.find((g) => g.id === ids.grant.supabaseCodex);
    expect(grant).toMatchObject({
      state: 'requested',
      scope: ['read', 'write'],
      reason: 'migration 0042',
      targetId: ids.target.supabaseProd,
    });
  });

  it('worktrees: main, fix/checkout (+142 −38 · 3 files, PR #214 draft), test/flaky, feat/promo (#212 merged)', () => {
    const acme = f.worktrees.filter((w) => w.projectId === ids.project.acmeShop);
    expect(acme.map((w) => w.branch)).toEqual(['main', 'fix/checkout', 'test/flaky', 'feat/promo', 'docs']);
    expect(acme[1]).toMatchObject({
      changes: { added: 142, removed: 38, files: 3 },
      pr: { number: 214, state: 'draft' },
    });
    expect(acme[3]?.pr).toMatchObject({ number: 212, state: 'merged' });
  });

  it('read models build for demo, empty and error variants', () => {
    expect(demoReadModel().sessions.ids).toHaveLength(8);
    const empty = emptyFixture();
    expect(empty.projects).toEqual([]);
    expect(empty.policies).toHaveLength(3);
    expect(emptyReadModel().projects.ids).toEqual([]);
    const err = errorFixture();
    expect(err.targets.find((t) => t.id === ids.target.awsProd)).toMatchObject({
      health: 'expired',
      expiredAt: DEMO_NOW - 2 * 60 * 60_000,
    });
    expect(err.clis.find((c) => c.agent === 'codex')).toMatchObject({ found: false, binary: null });
    expect(err.worktrees.find((w) => w.id === ids.worktree.fixCheckout)?.conflict).toEqual({
      file: 'checkout.ts',
      against: 'main',
    });
    expect(err.sessions.find((s) => s.id === ids.session.claude)).toMatchObject({
      state: 'paused',
      pausedReason: 'conflict',
    });
    expect(err.notifications.filter((n) => n.kind === 'error-banner').map((n) => n.title)).toEqual([
      'AWS acme-prod: credentials expired 2h ago. Agents requesting it are paused.',
      'codex not found on PATH. 1 session cannot start.',
      'fix/checkout conflicts with main in checkout.ts. Claude is paused until resolved.',
    ]);
    expect(errorReadModel().notifications.ids).toHaveLength(4);
  });

  it('never contains a secret value (only keychain refs)', () => {
    const text = JSON.stringify(f);
    expect(text).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(text).not.toMatch(/"(secret|token|password)":/i);
    expect(f.targets.every((t) => t.credentialRef?.startsWith('styx:v1:'))).toBe(true);
  });
});

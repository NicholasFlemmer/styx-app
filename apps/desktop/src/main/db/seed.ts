import { chainRows } from '../services/audit-service';
import { defaultPolicies, fixtures, type ProjectSettings } from '@styx/core';
import type { Repos } from './repos';

export type FixtureName = 'demo' | 'empty' | 'error';

export const isFixtureName = (s: string | undefined): s is FixtureName =>
  s === 'demo' || s === 'empty' || s === 'error';

export const loadFixture = (name: FixtureName): fixtures.DemoFixture =>
  name === 'demo'
    ? fixtures.demoFixture()
    : name === 'empty'
      ? fixtures.emptyFixture()
      : fixtures.errorFixture();

const AUDIT_COLS =
  'id, seq, time, actor_kind, actor_label, action, project_id, target_id, session_id, worktree_id, grant_id, policy_id, target_label, session_label, worktree_label, agent, scope_json, duration, triggered_by, detail_json, prev_hash, hash';

/**
 * Loads a core fixture into the DB. Idempotent: skips when any domain table already has rows unless `reset` is set.
 * `audit_entries` is append-only, so a reset keeps existing audit rows and ignores duplicate ids.
 */
export function seed(
  repos: Repos,
  fixture: fixtures.DemoFixture,
  opts: { reset?: boolean } = {},
): { seeded: boolean } {
  const db = repos.db;
  const populated =
    repos.projects.count() > 0 || repos.policies.all().length > 0 || repos.sessions.all().length > 0;
  if (populated && !opts.reset) return { seeded: false };

  const run = db.transaction(() => {
    if (opts.reset) {
      for (const t of [
        'agent_changes',
        'transcript_messages',
        'pending_asks',
        'grant_uses',
        'grants',
        'notifications',
        'targets',
        'worktrees',
        'sessions',
        'repos',
        'projects',
        'policies',
        'ide_installs',
        'cli_installs',
        'activity',
        'ui_state',
        'app_settings',
      ]) {
        db.exec(`DELETE FROM ${t}`);
      }
    }
    for (const p of fixture.projects) {
      const eff = fixture.projectSettings[p.id];
      const overrides: Partial<ProjectSettings> = {};
      if (eff)
        for (const [k, v] of Object.entries(eff))
          if (v.source === 'project') (overrides as Record<string, unknown>)[k] = v.value;
      repos.projects.upsert(p, overrides);
    }
    for (const r of fixture.repos) repos.repos.upsert(r);
    for (const s of fixture.sessions) repos.sessions.upsert(s);
    for (const w of fixture.worktrees) repos.worktrees.upsert(w);
    for (const t of fixture.targets) repos.targets.upsert(t);
    for (const p of fixture.policies) repos.policies.upsert(p);
    for (const g of fixture.grants) repos.grants.upsert(g);
    for (const a of fixture.pendingAsks) repos.pendingAsks.upsert(a);
    for (const list of Object.values(fixture.transcripts)) for (const m of list) repos.transcripts.upsert(m);
    const insertAudit = db.prepare(
      `INSERT OR IGNORE INTO audit_entries (${AUDIT_COLS}) VALUES (${AUDIT_COLS.split(',')
        .map(() => '?')
        .join(', ')})`,
    );
    const chained = chainRows(
      fixture.auditEntries.map((e) => ({
        id: e.id,
        seq: e.seq,
        time: e.time,
        actorKind: e.actorKind,
        actorLabel: e.actorLabel,
        action: e.action,
        projectId: e.projectId,
        targetId: e.targetId,
        sessionId: e.sessionId,
        worktreeId: e.worktreeId,
        grantId: e.grantId,
        policyId: e.policyId,
        targetLabel: e.targetLabel,
        sessionLabel: e.sessionLabel,
        worktreeLabel: e.worktreeLabel,
        agent: e.agent,
        scopeJson: e.scope === null ? null : JSON.stringify(e.scope),
        duration: e.duration,
        triggeredBy: e.triggeredBy ?? '',
        detailJson: JSON.stringify(e.detail),
      })),
    );
    for (const e of chained) {
      insertAudit.run(
        e.id, e.seq, e.time, e.actorKind, e.actorLabel, e.action, e.projectId, e.targetId, e.sessionId, e.worktreeId,
        e.grantId, e.policyId, e.targetLabel, e.sessionLabel, e.worktreeLabel, e.agent, e.scopeJson, e.duration,
        e.triggeredBy, e.detailJson, e.prevHash, e.hash,
      );
    }
    for (const list of Object.values(fixture.hunks)) for (const h of list) repos.agentChanges.upsert(h);
    for (const n of fixture.notifications) repos.notifications.upsert(n);
    for (const a of fixture.activity) repos.activity.insert(a);
    repos.discovery.replaceIdes(fixture.ides);
    repos.discovery.replaceClis(fixture.clis);
    repos.settings.patch(fixture.appSettings);
  });
  run();
  return { seeded: true };
}

/** Fresh installs get the three builtin policies (no fixture). */
export function seedDefaults(repos: Repos, now: number): void {
  if (repos.policies.all().length === 0) for (const p of defaultPolicies(now)) repos.policies.upsert(p);
}

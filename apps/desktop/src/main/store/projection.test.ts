import Database from 'better-sqlite3';
import { commands, fixtures } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate';
import { Repos } from '../db/repos';
import { loadFixture, seed } from '../db/seed';
import { buildSnapshot } from './projection';

function make(name: 'demo' | 'empty' | 'error') {
  const db = new Database(':memory:');
  migrate(db);
  const repos = new Repos(db, () => fixtures.DEMO_NOW);
  const fixture = loadFixture(name);
  const { seeded } = seed(repos, fixture);
  return { repos, fixture, seeded };
}

describe('projection', () => {
  it.each(['demo', 'empty', 'error'] as const)(
    'builds a contract-valid snapshot from the %s seed',
    (name) => {
      const { repos, fixture, seeded } = make(name);
      expect(seeded).toBe(true);
      const snap = buildSnapshot({ repos, popouts: () => [] }, 3);
      const parsed = commands['store.snapshot'].output.safeParse(snap);
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(
        true,
      );
      expect(snap.seq).toBe(3);
      expect(snap.projects.map((p) => p.id).sort()).toEqual(fixture.projects.map((p) => p.id).sort());
      expect(snap.sessions).toHaveLength(fixture.sessions.length);
      expect(snap.worktrees).toHaveLength(fixture.worktrees.length);
      expect(snap.targets).toHaveLength(fixture.targets.length);
      expect(snap.grants).toHaveLength(fixture.grants.length);
      expect(snap.pendingAsks).toHaveLength(fixture.pendingAsks.length);
      expect(snap.policies).toHaveLength(fixture.policies.length);
      expect(snap.auditEntries).toHaveLength(fixture.auditEntries.length);
      expect(snap.notifications).toHaveLength(fixture.notifications.length);
      expect(Object.keys(snap.transcripts).sort()).toEqual(Object.keys(fixture.transcripts).sort());
      expect(Object.keys(snap.hunks).sort()).toEqual(Object.keys(fixture.hunks).sort());
      expect(snap.discovery.clis).toHaveLength(fixture.clis.length);
      expect(snap.settings.app).toEqual(fixture.appSettings);
    },
  );

  it('round-trips entities exactly (demo)', () => {
    const { repos, fixture } = make('demo');
    const snap = buildSnapshot({ repos, popouts: () => [] }, 0);
    const byId = <T extends { id: string }>(rows: T[]) => Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId(snap.projects)).toEqual(byId(fixture.projects));
    expect(byId(snap.worktrees)).toEqual(byId(fixture.worktrees));
    expect(byId(snap.sessions)).toEqual(byId(fixture.sessions));
    expect(byId(snap.targets)).toEqual(byId(fixture.targets));
    expect(byId(snap.grants)).toEqual(byId(fixture.grants));
    expect(byId(snap.pendingAsks)).toEqual(byId(fixture.pendingAsks));
    expect(byId(snap.policies)).toEqual(byId(fixture.policies));
    const stripHashes = <T extends { id: string; hash?: unknown; prevHash?: unknown }>(rows: T[]) =>
      rows.map(({ hash: _h, prevHash: _p, ...rest }) => rest);
    expect(byId(stripHashes(snap.auditEntries))).toEqual(byId(stripHashes(fixture.auditEntries))); // seeding re-chains hashes
    expect(snap.transcripts).toEqual(fixture.transcripts);
    expect(snap.hunks).toEqual(fixture.hunks);
    expect(snap.settings.project[fixtures.ids.project.acmeShop]).toEqual(
      fixture.projectSettings[fixtures.ids.project.acmeShop],
    );
  });

  it('seed is idempotent unless reset', () => {
    const { repos, fixture } = make('demo');
    expect(seed(repos, fixture).seeded).toBe(false);
    expect(seed(repos, fixture, { reset: true }).seeded).toBe(true);
    expect(repos.projects.count()).toBe(fixture.projects.length);
  });
});

describe('hunks follow the tracking setting (Settings › Editor › Track agent edits)', () => {
  it('omits every hunk from the snapshot while trackAgentEdits is off', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = new Repos(db, () => fixtures.DEMO_NOW);
    seed(repos, loadFixture('demo'));
    expect(Object.keys(buildSnapshot({ repos, popouts: () => [] }, 1).hunks).length).toBeGreaterThan(0);
    repos.settings.patch({ trackAgentEdits: false });
    expect(buildSnapshot({ repos, popouts: () => [] }, 2).hunks).toEqual({});
  });
});

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate, listMigrations } from './migrate';

describe('migrations', () => {
  it('applies all migrations to a fresh database and records the version', () => {
    const db = new Database(':memory:');
    const res = migrate(db);
    expect(res.applied.length).toBe(listMigrations().length);
    expect(res.applied[0]).toBe('0000_init');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => (r as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining(['projects', 'sessions', 'worktrees', 'targets', 'grants', 'audit_entries', 'policies', 'pending_asks']));
    expect(migrate(db).applied).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('refuses a database newer than the build', () => {
    const db = new Database(':memory:');
    migrate(db);
    db.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
    expect(() => migrate(db)).toThrow(/newer/);
  });

  it('keeps audit_entries append-only', () => {
    const db = new Database(':memory:');
    migrate(db);
    db.prepare(
      "INSERT INTO audit_entries (id, seq, time, actor_kind, actor_label, action, triggered_by, prev_hash, hash) VALUES ('a', 1, 0, 'you', 'you', 'granted', 'grant sheet', '', 'h')",
    ).run();
    expect(() => db.prepare("UPDATE audit_entries SET action = 'denied' WHERE id = 'a'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM audit_entries WHERE id = 'a'").run()).toThrow(/append-only/);
  });

  it('enforces state invariants with CHECK constraints', () => {
    const db = new Database(':memory:');
    migrate(db);
    db.prepare("INSERT INTO projects (id, name, path, initials, created_at, last_activity_at) VALUES ('p', 'x', '/x', 'X', 0, 0)").run();
    const insert = (state: string, paused: string | null, ended: number | null) =>
      db
        .prepare("INSERT INTO sessions (id, project_id, agent, state, paused_reason, started_at, last_activity_at, ended_at) VALUES (?, 'p', 'claude', ?, ?, 0, 0, ?)")
        .run(`s-${state}-${paused}`, state, paused, ended);
    expect(() => insert('paused', null, null)).toThrow(/CHECK/);
    expect(() => insert('working', 'conflict', null)).toThrow(/CHECK/);
    expect(() => insert('done', null, null)).toThrow(/CHECK/);
    expect(() => insert('paused', 'conflict', null)).not.toThrow();
    expect(() => insert('done', null, 5)).not.toThrow();
  });
});

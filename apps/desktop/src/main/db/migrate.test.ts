import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate, listMigrations } from './migrate';

describe('migrations', () => {
  it('applies all migrations to a fresh database and records the version', () => {
    const db = new Database(':memory:');
    const res = migrate(db);
    expect(res.applied.length).toBe(listMigrations().length);
    expect(res.applied[0]).toBe('0000_init');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'projects',
        'sessions',
        'worktrees',
        'targets',
        'grants',
        'audit_entries',
        'policies',
        'pending_asks',
      ]),
    );
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
    expect(() => db.prepare("UPDATE audit_entries SET action = 'denied' WHERE id = 'a'").run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare("DELETE FROM audit_entries WHERE id = 'a'").run()).toThrow(/append-only/);
  });

  it('0002 widens targets.auth_method to cli, keeps rows, grants and the unique key (forward from a DB seeded at 0001)', () => {
    const db = new Database(':memory:');
    const all = listMigrations();
    expect(all.map((m) => m.name)).toEqual([
      '0000_init',
      '0001_activity',
      '0002_auth_method_cli',
      '0003_plain_folders',
      '0004_claude_parity',
      '0005_thinking',
      '0006_slash_commands',
      '0007_question_sets',
      '0008_user_pause',
      '0009_peer_messages',
      '0010_deploy',
      '0011_agent_connections',
      '0012_session_purpose',
      '0013_session_tokens',
      '0014_background_tasks',
      '0015_checkpoints_queue',
      '0016_checkpoint_screens',
      '0017_lane_behind_base',
      '0018_lane_overlaps',
      '0019_lane_resolution',
      '0020_lane_landing',
      '0021_task_kind',
      '0022_opencode_agent',
    ]);
    // Seed at 0001: a project, two targets and an active grant that cascades on the target.
    migrate(db, all.slice(0, 2));
    db.prepare(
      "INSERT INTO projects (id, name, path, initials, created_at, last_activity_at) VALUES ('p', 'x', '/x', 'X', 0, 0)",
    ).run();
    const insertTarget = db.prepare(
      "INSERT INTO targets (id, project_id, provider, name, env, auth_method, credential_ref, config_json, health, created_at) VALUES (?, 'p', ?, ?, ?, ?, ?, ?, 'ok', 1)",
    );
    insertTarget.run(
      't1',
      'aws',
      'AWS acme-prod',
      'prod',
      'key',
      'styx:v1:aws:t1:key',
      '{"region":"us-east-1"}',
    );
    insertTarget.run('t2', 'github', 'GitHub', 'scm', 'oauth', null, '{}');
    expect(() => insertTarget.run('t3', 'gcp', 'GCP', 'prod', 'cli', null, '{}')).toThrow(/CHECK/);
    db.prepare(
      "INSERT INTO grants (id, target_id, scope_json, scope_mask, duration, reason, state, requested_at, issued_at) VALUES ('g1', 't1', '[\"read\"]', 1, '1h', 'r', 'active', 1, 1)",
    ).run();

    const res = migrate(db, all.slice(0, 3));
    expect(res).toEqual({ applied: ['0002_auth_method_cli'], version: 3 });
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    const targets = db
      .prepare('SELECT id, auth_method, credential_ref, config_json FROM targets ORDER BY rowid')
      .all();
    expect(targets).toEqual([
      {
        id: 't1',
        auth_method: 'key',
        credential_ref: 'styx:v1:aws:t1:key',
        config_json: '{"region":"us-east-1"}',
      },
      { id: 't2', auth_method: 'oauth', credential_ref: null, config_json: '{}' },
    ]);
    expect(db.prepare("SELECT count(*) AS n FROM grants WHERE target_id = 't1'").get()).toEqual({ n: 1 }); // the rebuild did not cascade
    expect(() =>
      insertTarget.run('t3', 'gcp', 'GCP', 'prod', 'cli', 'styx:v1:gcp:t3:cli', '{}'),
    ).not.toThrow();
    expect(() => insertTarget.run('t4', 'gcp', 'GCP', 'prod', 'cli', null, '{}')).toThrow(/UNIQUE/); // (project, provider, env, name) survives
    expect(() => insertTarget.run('t5', 'gcp', 'GCP', 'prod', 'magic', null, '{}')).toThrow(/CHECK/);
    // FK actions are live again after the migration.
    db.prepare("DELETE FROM targets WHERE id = 't1'").run();
    expect(db.prepare('SELECT count(*) AS n FROM grants').get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'targets'").get()).toMatchObject({
      sql: expect.stringContaining("'cli'"),
    });
  });

  it('0003 makes repos.default_branch and worktrees.branch nullable, keeping rows, FKs and UNIQUE (forward from a DB seeded at 0002)', () => {
    const db = new Database(':memory:');
    const all = listMigrations();
    migrate(db, all.slice(0, 3));
    db.prepare(
      "INSERT INTO projects (id, name, path, initials, created_at, last_activity_at) VALUES ('p', 'x', '/x', 'X', 0, 0)",
    ).run();
    db.prepare(
      'INSERT INTO repos (id, project_id, default_branch, remotes_json) VALUES (\'r\', \'p\', \'main\', \'[{"name":"origin","url":"u"}]\')',
    ).run();
    const insertWt = db.prepare(
      "INSERT INTO worktrees (id, repo_id, branch, path, is_main, created_at) VALUES (?, 'r', ?, ?, ?, 1)",
    );
    insertWt.run('w1', 'main', '/x', 1);
    insertWt.run('w2', 'agent/claude-1', '/x-wt', 0);
    expect(() => insertWt.run('w3', null, '/y', 1)).toThrow(/NOT NULL/);
    db.prepare(
      "INSERT INTO sessions (id, project_id, worktree_id, agent, state, started_at, last_activity_at) VALUES ('s', 'p', 'w2', 'claude', 'idle', 0, 0)",
    ).run();
    db.prepare(
      "INSERT INTO agent_changes (id, session_id, worktree_id, file, hunk_hash, old_start, old_lines, new_start, new_lines, patch, status, first_seen_at, last_seen_at) VALUES ('c', 's', 'w2', 'a.ts', 'h', 1, 1, 1, 1, '', 'pending', 1, 1)",
    ).run();

    const res = migrate(db);
    expect(res).toEqual({
      applied: [
        '0003_plain_folders',
        '0004_claude_parity',
        '0005_thinking',
        '0006_slash_commands',
        '0007_question_sets',
        '0008_user_pause',
        '0009_peer_messages',
        '0010_deploy',
        '0011_agent_connections',
        '0012_session_purpose',
        '0013_session_tokens',
        '0014_background_tasks',
        '0015_checkpoints_queue',
        '0016_checkpoint_screens',
        '0017_lane_behind_base',
        '0018_lane_overlaps',
        '0019_lane_resolution',
        '0020_lane_landing',
        '0021_task_kind',
        '0022_opencode_agent',
      ],
      version: 23,
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.prepare('SELECT id, project_id, default_branch, remotes_json FROM repos').all()).toEqual([
      { id: 'r', project_id: 'p', default_branch: 'main', remotes_json: '[{"name":"origin","url":"u"}]' },
    ]);
    expect(db.prepare('SELECT id, branch, path, is_main FROM worktrees ORDER BY rowid').all()).toEqual([
      { id: 'w1', branch: 'main', path: '/x', is_main: 1 },
      { id: 'w2', branch: 'agent/claude-1', path: '/x-wt', is_main: 0 },
    ]);
    expect(db.prepare("SELECT count(*) AS n FROM agent_changes WHERE worktree_id = 'w2'").get()).toEqual({
      n: 1,
    }); // no cascade
    // Nullable now: a plain folder's repo row and main worktree; NULL branches never collide on UNIQUE (repo_id, branch).
    db.prepare(
      "INSERT INTO projects (id, name, path, initials, created_at, last_activity_at) VALUES ('p2', 'notes', '/notes', 'N', 0, 0)",
    ).run();
    db.prepare("INSERT INTO repos (id, project_id, default_branch) VALUES ('r2', 'p2', NULL)").run();
    db.prepare(
      "INSERT INTO worktrees (id, repo_id, branch, path, is_main, created_at) VALUES ('w3', 'r2', NULL, '/notes', 1, 1)",
    ).run();
    expect(() => insertWt.run('w4', 'main', '/x', 0)).toThrow(/UNIQUE/); // path stays unique
    expect(() => insertWt.run('w5', 'main', '/z', 0)).toThrow(/UNIQUE/); // (repo_id, branch) survives
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'worktrees_repo'").get(),
    ).toEqual({ name: 'worktrees_repo' });
    // FK actions are live again: deleting the repo cascades into its worktrees.
    db.prepare("DELETE FROM repos WHERE id = 'r2'").run();
    expect(db.prepare("SELECT count(*) AS n FROM worktrees WHERE id = 'w3'").get()).toEqual({ n: 0 });
  });

  it('0022 lets sessions and cli_installs name opencode, keeping every row and column (forward from 0021)', () => {
    const db = new Database(':memory:');
    const all = listMigrations();
    migrate(db, all.slice(0, 22));
    db.prepare(
      "INSERT INTO projects (id, name, path, initials, created_at, last_activity_at) VALUES ('p', 'x', '/x', 'X', 0, 0)",
    ).run();
    db.prepare(
      "INSERT INTO sessions (id, project_id, agent, state, started_at, last_activity_at, purpose, tokens_used, kind, design_session_id) VALUES ('s', 'p', 'gemini', 'idle', 1, 2, 'design', 7, 'design', 'd')",
    ).run();
    db.prepare(
      "INSERT INTO cli_installs (agent, binary, found, auth_state, checked_at, account) VALUES ('gemini', '/bin/gemini', 1, 'signed-in', 3, 'me@example.com')",
    ).run();
    const insertCli = db.prepare('INSERT INTO cli_installs (agent, found, checked_at) VALUES (?, 0, 0)');
    expect(() => insertCli.run('opencode')).toThrow(/CHECK/);

    expect(migrate(db, all.slice(0, 23))).toEqual({ applied: ['0022_opencode_agent'], version: 23 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(
      db
        .prepare('SELECT id, agent, purpose, tokens_used, kind, design_session_id, started_at FROM sessions')
        .all(),
    ).toEqual([
      {
        id: 's',
        agent: 'gemini',
        purpose: 'design',
        tokens_used: 7,
        kind: 'design',
        design_session_id: 'd',
        started_at: 1,
      },
    ]);
    expect(db.prepare('SELECT agent, binary, auth_state, account FROM cli_installs').all()).toEqual([
      { agent: 'gemini', binary: '/bin/gemini', auth_state: 'signed-in', account: 'me@example.com' },
    ]);
    expect(() => insertCli.run('opencode')).not.toThrow();
    expect(() => insertCli.run('aider')).toThrow(/CHECK/);
    db.prepare(
      "INSERT INTO sessions (id, project_id, agent, state, started_at, last_activity_at) VALUES ('s2', 'p', 'opencode', 'idle', 0, 0)",
    ).run();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sessions' AND sql IS NOT NULL ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: 'sessions_archive' }, { name: 'sessions_project_state' }]);
    // The project FK cascades again.
    db.prepare("DELETE FROM projects WHERE id = 'p'").run();
    expect(db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });

  it('enforces state invariants with CHECK constraints', () => {
    const db = new Database(':memory:');
    migrate(db);
    db.prepare(
      "INSERT INTO projects (id, name, path, initials, created_at, last_activity_at) VALUES ('p', 'x', '/x', 'X', 0, 0)",
    ).run();
    const insert = (state: string, paused: string | null, ended: number | null) =>
      db
        .prepare(
          "INSERT INTO sessions (id, project_id, agent, state, paused_reason, started_at, last_activity_at, ended_at) VALUES (?, 'p', 'claude', ?, ?, 0, 0, ?)",
        )
        .run(`s-${state}-${paused}`, state, paused, ended);
    expect(() => insert('paused', null, null)).toThrow(/CHECK/);
    expect(() => insert('working', 'conflict', null)).toThrow(/CHECK/);
    expect(() => insert('done', null, null)).toThrow(/CHECK/);
    expect(() => insert('paused', 'conflict', null)).not.toThrow();
    expect(() => insert('done', null, 5)).not.toThrow();
  });
});

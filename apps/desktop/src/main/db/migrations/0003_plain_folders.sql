-- Any folder can be a project (git optional): repos.default_branch and worktrees.branch become nullable. A plain
-- folder keeps default_branch NULL and one main worktree with branch NULL until `project.gitInit`.
-- SQLite cannot drop NOT NULL, so both tables are rebuilt (sqlite.org/lang_altertable.html §7): migrate() runs with
-- foreign_keys=OFF so the DROPs do not cascade (worktrees → repos; grants / agent_changes → worktrees), then runs
-- foreign_key_check. UNIQUE (repo_id, branch) survives; NULL branches never collide (SQLite treats NULLs as distinct).
CREATE TABLE repos_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  default_branch TEXT,
  remotes_json TEXT NOT NULL DEFAULT '[]',
  ahead INTEGER NOT NULL DEFAULT 0,
  behind INTEGER NOT NULL DEFAULT 0,
  fetched_at INTEGER,
  line_endings TEXT NOT NULL DEFAULT 'auto' CHECK (line_endings IN ('auto','lf','crlf')),
  long_paths INTEGER NOT NULL DEFAULT 0
);
INSERT INTO repos_new (id, project_id, default_branch, remotes_json, ahead, behind, fetched_at, line_endings, long_paths)
  SELECT id, project_id, default_branch, remotes_json, ahead, behind, fetched_at, line_endings, long_paths
  FROM repos ORDER BY rowid;
DROP TABLE repos;
ALTER TABLE repos_new RENAME TO repos;

CREATE TABLE worktrees_new (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  branch TEXT,
  path TEXT NOT NULL UNIQUE,
  is_main INTEGER NOT NULL DEFAULT 0,
  owner_kind TEXT NOT NULL DEFAULT 'user' CHECK (owner_kind IN ('user','session')),
  owner_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  base_commit TEXT,
  head_commit TEXT,
  added INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  files_changed INTEGER NOT NULL DEFAULT 0,
  pr_number INTEGER,
  pr_state TEXT CHECK (pr_state IN ('draft','open','merged','closed')),
  pr_url TEXT,
  conflict_file TEXT,
  conflict_against TEXT,
  merged_at INTEGER,
  created_at INTEGER NOT NULL,
  archived_at INTEGER,
  UNIQUE (repo_id, branch)
);
INSERT INTO worktrees_new (id, repo_id, branch, path, is_main, owner_kind, owner_session_id, base_commit, head_commit, added, removed, files_changed,
    pr_number, pr_state, pr_url, conflict_file, conflict_against, merged_at, created_at, archived_at)
  SELECT id, repo_id, branch, path, is_main, owner_kind, owner_session_id, base_commit, head_commit, added, removed, files_changed,
    pr_number, pr_state, pr_url, conflict_file, conflict_against, merged_at, created_at, archived_at
  FROM worktrees ORDER BY rowid;
DROP TABLE worktrees;
ALTER TABLE worktrees_new RENAME TO worktrees;
CREATE INDEX worktrees_repo ON worktrees(repo_id);

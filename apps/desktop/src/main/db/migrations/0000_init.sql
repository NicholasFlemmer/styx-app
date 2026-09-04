-- Styx schema v1. Hand-maintained: drizzle-kit does not emit CHECK constraints or triggers for SQLite.

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  initials TEXT NOT NULL,
  rail_order INTEGER NOT NULL DEFAULT 0,
  settings_json TEXT NOT NULL DEFAULT '{}',
  settings_mtime INTEGER,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  removed_at INTEGER
);

CREATE TABLE repos (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  default_branch TEXT NOT NULL DEFAULT 'main',
  remotes_json TEXT NOT NULL DEFAULT '[]',
  ahead INTEGER NOT NULL DEFAULT 0,
  behind INTEGER NOT NULL DEFAULT 0,
  fetched_at INTEGER,
  line_endings TEXT NOT NULL DEFAULT 'auto' CHECK (line_endings IN ('auto','lf','crlf')),
  long_paths INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  worktree_id TEXT,
  agent TEXT NOT NULL CHECK (agent IN ('claude','codex','gemini','cursor','shell')),
  runner TEXT NOT NULL DEFAULT 'pty' CHECK (runner IN ('pty','stream')),
  model TEXT,
  state TEXT NOT NULL CHECK (state IN ('idle','working','needs-you','done','paused')),
  paused_reason TEXT CHECK (paused_reason IN ('cli-missing','conflict','auth-expired')),
  note TEXT NOT NULL DEFAULT '',
  first_message TEXT,
  auto_approve_edits INTEGER NOT NULL DEFAULT 0,
  may_request_targets INTEGER NOT NULL DEFAULT 1,
  notify_when_needs_me INTEGER NOT NULL DEFAULT 1,
  broker_token_hash TEXT NOT NULL DEFAULT '',
  pid INTEGER,
  exit_code INTEGER,
  started_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  ended_at INTEGER,
  archived_at INTEGER,
  CHECK ((state = 'paused') = (paused_reason IS NOT NULL)),
  CHECK ((state = 'done') = (ended_at IS NOT NULL))
);
CREATE INDEX sessions_project_state ON sessions(project_id, state);
CREATE INDEX sessions_archive ON sessions(ended_at) WHERE archived_at IS NULL;

CREATE TABLE worktrees (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
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
CREATE INDEX worktrees_repo ON worktrees(repo_id);

CREATE TABLE targets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('vercel','aws','gcp','supabase','github','ssh')),
  name TEXT NOT NULL,
  env TEXT NOT NULL CHECK (env IN ('prod','staging','preview','scm')),
  auth_method TEXT NOT NULL CHECK (auth_method IN ('oauth','key','ssh')),
  policy TEXT NOT NULL DEFAULT 'ask' CHECK (policy IN ('ask-mfa','ask','always')),
  policy_source TEXT NOT NULL DEFAULT 'app' CHECK (policy_source IN ('app','project')),
  credential_ref TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  health TEXT NOT NULL DEFAULT 'unconnected' CHECK (health IN ('ok','expired','unconnected')),
  health_checked_at INTEGER,
  expired_at INTEGER,
  from_project_file INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, provider, env, name)
);

CREATE TABLE policies (
  id TEXT PRIMARY KEY,
  ord INTEGER NOT NULL,
  rule_json TEXT NOT NULL,
  rule_text TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  builtin_key TEXT UNIQUE,
  match_count_today INTEGER NOT NULL DEFAULT 0,
  match_count_week INTEGER NOT NULL DEFAULT 0,
  counters_reset_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX policies_ord ON policies(ord);

CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
  scope_json TEXT NOT NULL,
  scope_mask INTEGER NOT NULL,
  duration TEXT NOT NULL CHECK (duration IN ('once','1h','session','always')),
  reason TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('requested','active','denied','revoked','expired')),
  requested_at INTEGER NOT NULL,
  issued_at INTEGER,
  expires_at INTEGER,
  last_used_at INTEGER,
  idle_expires_at INTEGER,
  revoked_at INTEGER,
  revoke_reason TEXT CHECK (revoke_reason IN ('user','expired','idle','session-end','once-used','target-removed','policy')),
  policy_id TEXT REFERENCES policies(id) ON DELETE SET NULL,
  mfa_verified INTEGER NOT NULL DEFAULT 0,
  decided_by TEXT CHECK (decided_by IN ('user','policy','target-policy','persistent-grant')),
  cred_nonce TEXT,
  CHECK ((state IN ('active','revoked','expired')) = (issued_at IS NOT NULL)),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX grants_target_active ON grants(target_id) WHERE state = 'active';
CREATE INDEX grants_session_requested ON grants(session_id, requested_at) WHERE state = 'requested';
CREATE INDEX grants_expiry ON grants(expires_at) WHERE state = 'active' AND expires_at IS NOT NULL;

CREATE TABLE grant_uses (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  via TEXT NOT NULL CHECK (via IN ('shim','get_credential','ssh-agent-sign','styx-cli')),
  command TEXT,
  scope_used TEXT,
  exit_code INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE pending_asks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('grant','plan','decision','question')),
  grant_id TEXT REFERENCES grants(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL CHECK (state IN ('open','resolved','cancelled')),
  resolution_json TEXT,
  position INTEGER NOT NULL,
  broker_request_id TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  CHECK ((kind = 'grant') = (grant_id IS NOT NULL))
);
CREATE INDEX pending_asks_open ON pending_asks(session_id, position) WHERE state = 'open';

CREATE TABLE transcript_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('user','agent','file-list','decision','access-request','system')),
  body TEXT NOT NULL,
  payload_json TEXT,
  ask_id TEXT REFERENCES pending_asks(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE TABLE audit_entries (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  time INTEGER NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('you','system','agent')),
  actor_label TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('requested','granted','denied','used','revoked','expired','opened-pr','merged-pr','connected','disconnected','tested','policy-changed','exported')),
  project_id TEXT,
  target_id TEXT,
  session_id TEXT,
  worktree_id TEXT,
  grant_id TEXT,
  policy_id TEXT,
  target_label TEXT,
  session_label TEXT,
  worktree_label TEXT,
  agent TEXT,
  scope_json TEXT,
  duration TEXT,
  triggered_by TEXT NOT NULL,
  detail_json TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX audit_time ON audit_entries(time DESC);
CREATE INDEX audit_target ON audit_entries(target_id, time DESC);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_entries BEGIN SELECT RAISE(ABORT, 'audit_entries is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_entries BEGIN SELECT RAISE(ABORT, 'audit_entries is append-only'); END;

CREATE TABLE agent_changes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  hunk_hash TEXT NOT NULL,
  old_start INTEGER NOT NULL,
  old_lines INTEGER NOT NULL,
  new_start INTEGER NOT NULL,
  new_lines INTEGER NOT NULL,
  patch TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected','stale')),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  decided_at INTEGER,
  UNIQUE (worktree_id, hunk_hash)
);
CREATE INDEX agent_changes_pending ON agent_changes(worktree_id) WHERE status = 'pending';

CREATE TABLE ide_installs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('vscode','cursor','jetbrains','neovim')),
  product TEXT,
  version TEXT,
  location TEXT NOT NULL,
  launcher TEXT,
  config_dir TEXT,
  is_fallback INTEGER NOT NULL DEFAULT 0,
  imported_json TEXT NOT NULL DEFAULT '{}',
  detected_at INTEGER NOT NULL,
  UNIQUE (kind, product)
);

CREATE TABLE cli_installs (
  agent TEXT PRIMARY KEY CHECK (agent IN ('claude','codex','gemini','cursor','shell')),
  binary TEXT,
  version TEXT,
  found INTEGER NOT NULL DEFAULT 0,
  auth_state TEXT NOT NULL DEFAULT 'unknown' CHECK (auth_state IN ('signed-in','signed-out','unknown','n/a')),
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  checked_at INTEGER NOT NULL
);

CREATE TABLE ui_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE window_state (
  key TEXT PRIMARY KEY,
  x INTEGER,
  y INTEGER,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  display_id TEXT,
  maximized INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('needs-you','grant-result','error-banner','info')),
  session_id TEXT,
  ask_id TEXT,
  project_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  meta TEXT,
  os_delivered INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('shown','later','acted','dismissed','resolved')),
  banner_key TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

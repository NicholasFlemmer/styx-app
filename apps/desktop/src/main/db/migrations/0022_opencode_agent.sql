-- 0022: OpenCode joins the agent CLIs (issue #17). `sessions.agent` and `cli_installs.agent` carry a CHECK that
-- SQLite cannot widen in place, so both tables are rebuilt (same recipe as 0008). The column lists match the
-- tables as they stand after 0021 (sessions) and 0011 (cli_installs); migrate() runs with foreign_keys=OFF.
CREATE TABLE sessions_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  worktree_id TEXT,
  agent TEXT NOT NULL CHECK (agent IN ('claude','codex','gemini','cursor','opencode','shell')),
  runner TEXT NOT NULL DEFAULT 'pty' CHECK (runner IN ('pty','stream')),
  model TEXT,
  state TEXT NOT NULL CHECK (state IN ('idle','working','needs-you','done','paused')),
  paused_reason TEXT CHECK (paused_reason IN ('cli-missing','conflict','auth-expired','user')),
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
  permission_mode TEXT NOT NULL DEFAULT 'default'
    CHECK (permission_mode IN ('default','acceptEdits','plan','bypassPermissions','dontAsk','auto')),
  effort TEXT CHECK (effort IN ('low','medium','high','xhigh','max')),
  cli_session_id TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  num_turns INTEGER NOT NULL DEFAULT 0,
  slash_commands_json TEXT NOT NULL DEFAULT '[]',
  purpose TEXT,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  context_window INTEGER,
  task_target_id TEXT,
  kind TEXT,
  design_session_id TEXT,
  CHECK ((state = 'paused') = (paused_reason IS NOT NULL)),
  CHECK ((state = 'done') = (ended_at IS NOT NULL))
);
INSERT INTO sessions_new (id, project_id, worktree_id, agent, runner, model, state, paused_reason, note, first_message, auto_approve_edits, may_request_targets, notify_when_needs_me, broker_token_hash, pid, exit_code, started_at, last_activity_at, ended_at, archived_at, permission_mode, effort, cli_session_id, cost_usd, num_turns, slash_commands_json, purpose, tokens_used, context_window, task_target_id, kind, design_session_id)
  SELECT id, project_id, worktree_id, agent, runner, model, state, paused_reason, note, first_message, auto_approve_edits, may_request_targets, notify_when_needs_me, broker_token_hash, pid, exit_code, started_at, last_activity_at, ended_at, archived_at, permission_mode, effort, cli_session_id, cost_usd, num_turns, slash_commands_json, purpose, tokens_used, context_window, task_target_id, kind, design_session_id FROM sessions ORDER BY rowid;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
CREATE INDEX sessions_project_state ON sessions(project_id, state);
CREATE INDEX sessions_archive ON sessions(ended_at) WHERE archived_at IS NULL;

CREATE TABLE cli_installs_new (
  agent TEXT PRIMARY KEY CHECK (agent IN ('claude','codex','gemini','cursor','opencode','shell')),
  binary TEXT,
  version TEXT,
  found INTEGER NOT NULL DEFAULT 0,
  auth_state TEXT NOT NULL DEFAULT 'unknown' CHECK (auth_state IN ('signed-in','signed-out','unknown','n/a')),
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  checked_at INTEGER NOT NULL,
  account TEXT,
  verified_at INTEGER,
  verify_error TEXT
);
INSERT INTO cli_installs_new (agent, binary, version, found, auth_state, capabilities_json, checked_at, account, verified_at, verify_error)
  SELECT agent, binary, version, found, auth_state, capabilities_json, checked_at, account, verified_at, verify_error
  FROM cli_installs ORDER BY rowid;
DROP TABLE cli_installs;
ALTER TABLE cli_installs_new RENAME TO cli_installs;

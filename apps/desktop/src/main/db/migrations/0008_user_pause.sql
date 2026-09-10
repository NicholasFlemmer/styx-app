-- `paused` used to mean only "Styx detected a fault" (cli-missing | conflict | auth-expired), each of which
-- raises a banner. A user pausing an agent from the chat is the same state with a different cause and no
-- banner, so `paused_reason` gains 'user'. The table is rebuilt because SQLite CHECK constraints cannot be
-- altered in place; the column list matches the table as it stands after 0004/0005/0006 added the Claude
-- parity columns (migrate() runs with foreign_keys=OFF).
CREATE TABLE sessions_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  worktree_id TEXT,
  agent TEXT NOT NULL CHECK (agent IN ('claude','codex','gemini','cursor','shell')),
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
  CHECK ((state = 'paused') = (paused_reason IS NOT NULL)),
  CHECK ((state = 'done') = (ended_at IS NOT NULL))
);
INSERT INTO sessions_new (id, project_id, worktree_id, agent, runner, model, state, paused_reason, note, first_message, auto_approve_edits, may_request_targets, notify_when_needs_me, broker_token_hash, pid, exit_code, started_at, last_activity_at, ended_at, archived_at, permission_mode, effort, cli_session_id, cost_usd, num_turns, slash_commands_json)
  SELECT id, project_id, worktree_id, agent, runner, model, state, paused_reason, note, first_message, auto_approve_edits, may_request_targets, notify_when_needs_me, broker_token_hash, pid, exit_code, started_at, last_activity_at, ended_at, archived_at, permission_mode, effort, cli_session_id, cost_usd, num_turns, slash_commands_json FROM sessions ORDER BY rowid;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
CREATE INDEX sessions_project_state ON sessions(project_id, state);
CREATE INDEX sessions_archive ON sessions(ended_at) WHERE archived_at IS NULL;

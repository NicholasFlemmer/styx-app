-- Styx can now run a deploy itself (the palette's "Deploy {project} → {target}" row, which until now navigated
-- and did nothing). A deploy takes a `deploy`-scoped grant like anything else that touches a target, so it
-- records a grant use — but the actor is the app on the user's behalf, not a shim or an agent, hence a new
-- `via` value. Rebuilt because SQLite CHECK constraints cannot be altered in place.
CREATE TABLE grant_uses_new (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  via TEXT NOT NULL CHECK (via IN ('shim','get_credential','ssh-agent-sign','styx-cli','app')),
  command TEXT,
  scope_used TEXT,
  exit_code INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
INSERT INTO grant_uses_new (id, grant_id, session_id, via, command, scope_used, exit_code, started_at, ended_at)
  SELECT id, grant_id, session_id, via, command, scope_used, exit_code, started_at, ended_at FROM grant_uses ORDER BY rowid;
DROP TABLE grant_uses;
ALTER TABLE grant_uses_new RENAME TO grant_uses;

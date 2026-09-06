-- Claude Code parity: per-session permission mode / effort (switchable live), the CLI's own session id for
-- `--resume` on relaunch, running cost / turn counters from stream `result` events, and a `tool` transcript kind for
-- tool-call lines. transcript_messages is rebuilt to widen its `kind` CHECK (migrate() runs with foreign_keys=OFF).
ALTER TABLE sessions ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'default'
  CHECK (permission_mode IN ('default','acceptEdits','plan','bypassPermissions','dontAsk','auto'));
ALTER TABLE sessions ADD COLUMN effort TEXT CHECK (effort IN ('low','medium','high','xhigh','max'));
ALTER TABLE sessions ADD COLUMN cli_session_id TEXT;
ALTER TABLE sessions ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN num_turns INTEGER NOT NULL DEFAULT 0;

CREATE TABLE transcript_messages_new (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('user','agent','file-list','decision','access-request','system','tool')),
  body TEXT NOT NULL,
  payload_json TEXT,
  ask_id TEXT REFERENCES pending_asks(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (session_id, seq)
);
INSERT INTO transcript_messages_new (id, session_id, seq, kind, body, payload_json, ask_id, created_at)
  SELECT id, session_id, seq, kind, body, payload_json, ask_id, created_at FROM transcript_messages ORDER BY rowid;
DROP TABLE transcript_messages;
ALTER TABLE transcript_messages_new RENAME TO transcript_messages;

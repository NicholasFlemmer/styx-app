-- An AskUserQuestion call carries up to 4 related questions meant to be answered together. They used to be
-- exploded into one `decision` ask each and surfaced one at a time, which read as unrelated prompts arriving
-- out of order; a free-text question rendered as plain agent prose with no way to answer it at all, leaving the
-- session stuck in needs-you with nothing to click. Both now travel as a single `questions` ask carrying the
-- whole set (multi-select, per-option descriptions and free text included), and plans get their own transcript
-- kind so they render as an approvable card rather than prose.
-- Both tables are rebuilt to widen their `kind` CHECK (migrate() runs with foreign_keys=OFF).
CREATE TABLE pending_asks_new (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('grant','plan','decision','question','questions')),
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
INSERT INTO pending_asks_new (id, session_id, kind, grant_id, payload_json, state, resolution_json, position, broker_request_id, created_at, resolved_at)
  SELECT id, session_id, kind, grant_id, payload_json, state, resolution_json, position, broker_request_id, created_at, resolved_at FROM pending_asks ORDER BY rowid;
DROP TABLE pending_asks;
ALTER TABLE pending_asks_new RENAME TO pending_asks;
CREATE INDEX pending_asks_open ON pending_asks(session_id, position) WHERE state = 'open';

CREATE TABLE transcript_messages_new (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('user','agent','file-list','decision','access-request','system','tool','thinking','questions','plan')),
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

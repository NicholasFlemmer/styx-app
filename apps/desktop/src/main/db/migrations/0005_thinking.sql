-- Thinking blocks from the Claude stream get their own transcript kind (streamed live, then collapsed to
-- "Thought for Ns"). transcript_messages is rebuilt to widen its `kind` CHECK (migrate() runs with foreign_keys=OFF).
CREATE TABLE transcript_messages_new (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('user','agent','file-list','decision','access-request','system','tool','thinking')),
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

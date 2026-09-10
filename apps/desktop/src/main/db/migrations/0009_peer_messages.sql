-- Agents in one project can now message each other. A peer's text gets its own transcript kind rather than
-- reusing `user`: rendering it as if the human typed it would be a lie, and the receiving agent weights its
-- operator's words differently from another agent's, so it would also be a prompt-injection primitive.
-- Rebuilt because SQLite CHECK constraints cannot be altered in place (migrate() runs with foreign_keys=OFF).
CREATE TABLE transcript_messages_new (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('user','agent','file-list','decision','access-request','system','tool','thinking','questions','plan','peer')),
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

-- Home → Activity feed (read model `activity`, delta `activity.append`). Appended by main, capped on read.
CREATE TABLE activity (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  who TEXT NOT NULL,
  what TEXT NOT NULL,
  project_id TEXT,
  session_id TEXT
);
CREATE INDEX activity_at ON activity(at DESC);

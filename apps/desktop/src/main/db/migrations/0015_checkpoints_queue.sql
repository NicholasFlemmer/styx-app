-- Turn checkpoints: one row per agent turn, pointing at hidden git refs (refs/styx/checkpoints/<session>/<n>)
-- so the turn can be diffed and reverted without a commit on the user's branch.
CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  turn INTEGER NOT NULL,
  message_id TEXT,
  base_ref TEXT NOT NULL,
  ref TEXT,
  files INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  reverted_at INTEGER
);
CREATE INDEX checkpoints_session ON checkpoints(session_id, turn);

-- Messages held back while an agent is mid-turn (Claude Code has no steer): sent when the turn settles.
CREATE TABLE queued_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  files_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX queued_messages_session ON queued_messages(session_id, created_at);

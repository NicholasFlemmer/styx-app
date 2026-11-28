-- 0026: a task's result (ADR-0033): a campaign or a report the agent handed over with `show_result`, one per task,
-- replaced when it sends a new one. The JSON is zod-checked on the way in and out; strings were redacted first.
CREATE TABLE task_results (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('campaign','report')),
  body_json TEXT NOT NULL,
  launch_approved_at INTEGER,
  launch_picked_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
CREATE INDEX task_results_project ON task_results(project_id, updated_at);

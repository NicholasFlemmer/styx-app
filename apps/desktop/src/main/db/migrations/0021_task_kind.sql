-- 0021: design and build tasks (discrepancy #140). `kind` is 'design' or 'build' (NULL on older rows = build);
-- a build task started from a design names its design task.
ALTER TABLE sessions ADD COLUMN kind TEXT;
ALTER TABLE sessions ADD COLUMN design_session_id TEXT;

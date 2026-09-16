-- Keep background deploy tasks attached to their target across windows and reloads.
ALTER TABLE sessions ADD COLUMN task_target_id TEXT;

-- 0028: a report kept up to date (ADR-0033): re-run every week while Styx is open; when it last asked.
ALTER TABLE task_results ADD COLUMN weekly INTEGER NOT NULL DEFAULT 0 CHECK (weekly IN (0, 1));
ALTER TABLE task_results ADD COLUMN last_run_at INTEGER;

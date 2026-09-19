-- Landing (ADR-0025 phase C): how a lane landed in the base branch — the landing commit, the base, whether it was
-- pushed, when, and when it was undone. JSON, nullable.
ALTER TABLE worktrees ADD COLUMN landing_json TEXT;

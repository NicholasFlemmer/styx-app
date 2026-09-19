-- Styx finishes the merge (ADR-0025 phase B): the base merge an agent is resolving on a lane, or how the last one
-- ended — conflicted files, the resolving session, HEAD and a tree checkpoint from before the merge (Undo), the
-- merge commit, attempts, failure text. JSON, nullable.
ALTER TABLE worktrees ADD COLUMN resolution_json TEXT;

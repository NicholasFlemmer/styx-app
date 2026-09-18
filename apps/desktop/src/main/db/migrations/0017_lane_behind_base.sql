-- Keep lanes current (ADR-0023): how many commits on the project's base branch a lane has not merged in yet,
-- refreshed by worktree.fetch / the refresh scheduler and reset by worktree.sync.
ALTER TABLE worktrees ADD COLUMN behind_base INTEGER NOT NULL DEFAULT 0;

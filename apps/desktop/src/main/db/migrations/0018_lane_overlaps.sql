-- Lanes that know about each other (ADR-0025): the other live lanes that changed files this lane changed too, as
-- JSON [{ worktreeId, files }]. Refreshed by the lane ledger on every hunk rescan and lane refresh; advisory only.
ALTER TABLE worktrees ADD COLUMN overlaps_json TEXT NOT NULL DEFAULT '[]';

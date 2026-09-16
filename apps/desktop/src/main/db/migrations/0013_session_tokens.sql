-- Token totals for CLIs that report tokens rather than dollars (Codex app-server `thread/tokenUsage/updated`):
-- the chat meta line shows "14.6k tokens · 3 turns" where Claude shows "$0.12 · 3 turns". Plain ADD COLUMN.
ALTER TABLE sessions ADD COLUMN tokens_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN context_window INTEGER;

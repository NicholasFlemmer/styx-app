-- 0027: what the person approved for a campaign (their edits to the ads and the plan, ADR-0033), the campaign it
-- made, and when they paused it. JSON is zod-checked in and out.
ALTER TABLE task_results ADD COLUMN approved_json TEXT;
ALTER TABLE task_results ADD COLUMN campaign_id TEXT;
ALTER TABLE task_results ADD COLUMN paused_at INTEGER;

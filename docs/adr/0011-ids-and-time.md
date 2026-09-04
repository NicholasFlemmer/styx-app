# ADR-0011 IDs are ULIDs, timestamps are epoch milliseconds

Status: accepted · 2026-09-04
Branded id types in `packages/core/src/ids.ts`. All times are `number` (ms) in SQLite, store and IPC; formatting (`2m`, `open · 58m left`) happens in selectors with injected `now`.

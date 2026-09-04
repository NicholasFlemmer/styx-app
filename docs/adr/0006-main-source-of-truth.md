# ADR-0006 Main process is the source of truth; renderer mirrors via snapshot + deltas

Status: accepted · 2026-09-04
SQLite (better-sqlite3 + Drizzle) in main. Renderer holds a normalized read model (Zustand + immer) fed by `store.snapshot` on connect and seq-numbered `store.delta` batches (resync on gap). Every mutation is a zod-validated command over `styx:cmd`. No optimistic domain updates (the grant sheet closes eagerly; that is UI state). Timestamps are epoch ms numbers; IDs are ULIDs.

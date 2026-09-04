---
name: db-migration
description: Drizzle schema change workflow for the main-process SQLite - edit schema, generate migration, hand-add CHECK/triggers, update seed/fixtures, test forward + rollback, keep audit table append-only.
argument-hint: '<change summary>'
allowed-tools: Read, Edit, Write, Bash(pnpm:*), Bash(sqlite3:*)
---

# DB migration: $ARGUMENTS

1. Edit `apps/desktop/src/main/db/schema.ts`.
2. `pnpm db:generate` → review SQL in `apps/desktop/src/main/db/migrations/`; add `CHECK` constraints and triggers by hand (drizzle-kit does not emit them for SQLite).
3. `audit_entries`: additive changes only; the `RAISE(ABORT)` triggers stay.
4. Update zod row schemas / mappers in core, `packages/core/src/fixtures/demo.ts`, and `scripts/seed.ts`.
5. Test: migrate a fresh DB; migrate a DB seeded at the previous version; verify data. Reversible changes get a down migration + test.
6. Column-name review: any `token|secret|password|key` column that could hold a secret is rejected (only `credential_ref`).
7. `pnpm test -F @styx/desktop`.

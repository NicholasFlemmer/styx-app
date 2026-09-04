---
paths: ['**/*.test.ts', '**/*.test.tsx', '**/e2e/**', '**/*.stories.tsx']
---

# Testing rules

- core tests are table-driven and deterministic: inject `now`, use fixtures from `packages/core/src/fixtures/demo.ts` so expected strings match the prototype (`'02'`, `'open · 58m'`, `'codex · test/flaky · 3m · waiting on you'`).
- Machines: one test row per (state, event) pair including invalid pairs → `null`.
- ui tests: behaviour only (keyboard, focus, aria); visuals are covered by stories + visual diff.
- e2e: launch via `_electron.launch` with `STYX_FIXTURE=demo STYX_NOW=<fixed> STYX_KEYCHAIN=memory`; never touch the real keychain or real providers.
- Stories: one per variant × state plus a `Matrix` story; theme/platform via toolbar globals.

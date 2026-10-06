---
paths: ['**/*.test.ts', '**/*.test.tsx', '**/e2e/**', '**/*.stories.tsx']
---

# Testing rules

- core tests are table-driven and deterministic: inject `now`, use fixtures from `packages/core/src/fixtures/demo.ts`,
  and take expected strings from `copy.ts` (or `fill()` of it) rather than retyping them.
- Machines: one test row per (state, event) pair including invalid pairs → `null`.
- ui tests: behaviour only (keyboard, focus, aria); visuals are covered by stories + visual diff.
- e2e: launch through `e2e/launch.ts` (`STYX_E2E=1`, `STYX_FIXTURE=demo`, a fixed `STYX_NOW`, `STYX_KEYCHAIN=memory`,
  fake CLIs from `e2e/fixtures/bin` first on PATH); never touch the real keychain or real providers.
- Time limits a test sets itself go through `slow(ms)` (`apps/desktop/src/main/test-timeouts.ts`), so CI gets headroom.
- Stories: one per variant × state plus a `Matrix` story; theme/platform via toolbar globals.

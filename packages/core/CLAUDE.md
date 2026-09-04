# @styx/core

Pure TypeScript. No Electron, DOM, fs, timers with side effects, or network. Everything runs in vitest with no mocks.

- `model/` entities (spec §1 names exact: Project, Repo, Worktree, Session, Target, Grant, AuditEntry, Policy, Hunk, TranscriptMessage, PendingAsk) + zod schemas.
- `machines/session.ts`, `machines/grant.ts`: `transition(state, event, ctx) => { state, effects[] } | null`. Effects are data executed by main.
- `policy/` `evaluatePolicies()`; `selectors/` derived state (needsYouCount, lockedCount, activeGrants, boardColumns, sessionTabs, paletteResults, targetDerivedState, countdowns).
- `ipc/contract.ts`: commands + events with zod schemas. Adding a command = `/ipc-command`.
- `copy.ts`: spec §10 strings verbatim; `keys/`: shortcut parsing/formatting per platform.
- Tests are table-driven; a machine change without a test for every new transition is incomplete (`/state-machine-change`).
- Time is injected (`ctx.now`), never `Date.now()` in this package.

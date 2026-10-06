# @styx/core

Pure TypeScript. No Electron, DOM, fs, timers with side effects, or network. Everything runs in vitest with no mocks.

- `model/`: entities and their zod schemas (project, session, grant, target, audit, policy, hunk, checkpoint, design,
  settings, usage-report, …). `ids.ts` has the branded ULID types; `project-file.ts` the `.styx/project.json` schema.
- `machines/session.ts`, `machines/grant.ts`: `transition(state, event, ctx) => { state, effects[] } | null`. Effects
  are data executed by main.
- `policy/` `evaluatePolicies()`; `selectors/` derived state (counts, board, lanes, tasks, turns, palette, inbox,
  usage, target state, …).
- `ipc/contract.ts`: commands + events with zod schemas; `ipc/api.ts` types `window.styx`. Adding a command =
  `/ipc-command`.
- `copy.ts`: every user-facing string (spec §10 wording where it still applies, plus the agent prompts); `keys/`:
  shortcut parsing/formatting per platform. `fixtures/demo.ts`: the demo/empty/error fixtures.
- Tests are table-driven; 100% coverage is enforced on `machines/`, `policy/`, `selectors/`, `arcade/`. A machine
  change without a test for every new transition is incomplete (`/state-machine-change`).
- Time is injected (`ctx.now`), never `Date.now()` in this package. No `!` non-null assertions (lint error here).

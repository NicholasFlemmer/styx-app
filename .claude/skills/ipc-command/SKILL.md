---
name: ipc-command
description: Add a command end-to-end - zod schema in packages/core/src/ipc/contract.ts, main-process handler, typed renderer usage, contract test. Use for any new mutation (spawn session, grant, revoke, connect target, accept hunk...).
argument-hint: '<domain.command>'
allowed-tools: Read, Grep, Glob, Edit, Write, Bash(pnpm:*)
---

# IPC command: $ARGUMENTS

1. Add `'$0': { input: z…, output: z… }` to `packages/core/src/ipc/contract.ts` (`commands` map). Output must not contain secrets.
2. If state changes: add the machine event/effect first (`/state-machine-change`).
3. Main: implement in `apps/desktop/src/main/ipc/commands/<domain>.ts` via `registerCommand('$0', async (input, ctx) => …)`: parse → transaction → transition → execute effects via services → `audit.append` when applicable → the store publisher emits deltas.
4. Renderer: call `commands['$0'](input)` from `state/commands.ts`; wait for the delta (no optimistic domain state).
5. Tests: schema round-trip; handler test with in-memory SQLite + fake services; one renderer test that the CTA invokes it.
6. `pnpm typecheck && pnpm test`.

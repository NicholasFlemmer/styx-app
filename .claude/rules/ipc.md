---
paths: ['apps/desktop/src/main/**', 'apps/desktop/src/preload/**', 'packages/core/src/ipc/**']
---

# IPC rules

- One channel for commands (`styx:cmd`), one for store deltas (`styx:store`), one for pty bytes (`styx:pty`). No other `ipcMain.handle` names.
- Handlers validate `event.senderFrame` origin and window registry, then `contract.commands[name].input.parse(input)`; unknown names rejected before parsing.
- Handlers return `{ ok: true, value } | { ok: false, error: { code, message } }`; never throw across IPC. Never include secrets in inputs, outputs, or deltas.
- State changes go: transaction → machine transition → effects → audit → `store.delta`. The renderer waits for the delta (no optimistic domain updates).
- `fs.*` commands must resolve inside the worktree path (`path.resolve(root, p).startsWith(root + sep)`).

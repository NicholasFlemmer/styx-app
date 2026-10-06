---
paths: ['apps/desktop/src/main/**', 'apps/desktop/src/preload/**', 'packages/core/src/ipc/**']
---

# IPC rules

- Four channels: commands (`styx:cmd`), store deltas (`styx:store`), one-off events such as `deploy.progress` or
  `device.frame` (`styx:evt`, `EVENT_CHANNEL` in `store/publisher.ts`), and pty bytes (`styx:pty`). No other
  `ipcMain.handle` names.
- Handlers validate `event.senderFrame` origin and window registry, then `contract.commands[name].input.parse(input)`; unknown names rejected before parsing.
- Handlers return `{ ok: true, value } | { ok: false, error: { code, message } }`; never throw across IPC. Never include secrets in inputs, outputs, or deltas.
- State changes go: transaction → machine transition → effects → audit → `store.delta`. The renderer waits for the delta (no optimistic domain updates).
- `fs.*` commands must resolve inside the worktree path (`path.resolve(root, p).startsWith(root + sep)`).

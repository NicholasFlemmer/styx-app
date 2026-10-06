# apps/desktop

Electron app. Three isolated trees: `src/main` (Node, source of truth), `src/preload` (contextBridge only),
`src/renderer` (React 19, no Node).

- `src/main/container.ts` builds every service once with injected deps (clock, vault, CLI runners, windows). No
  singletons at import time. Tests build the same graph with `makeTestApp()` (`src/main/test-support.ts`).
- `src/main/ipc/commands/<domain>.ts` registers handlers for core commands; `ipc/bus.ts` validates the sender and the
  core zod schema before any service is touched.
- `src/main/services/`: sessions and runners (`session-service`, `stream-runner`, `app-server-runner`, `acp-runner`,
  `runner-mux`, `pty-service`), lanes (`worktree-service`, `lane-sync-service`, `lane-ledger-service`,
  `land-service`, `merge-resolve-service`, `publish-service`, `checkpoint-service`), access (`grant-service`,
  `audit-service`, `mfa-service`, `credential-vault`, `target-service`), plus run/preview, design, devices, skills,
  agent setup, updates, notifications, windows. `src/main/agents/` has one file per agent CLI;
  `src/main/providers/` one adapter per target; `src/main/broker/host.ts` answers broker calls; `src/main/db/` holds
  the drizzle schema, SQL migrations and seed.
- `src/main/store/` projects SQLite into the read model and publishes seq-numbered delta batches to every window;
  `store.snapshot` on connect or seq gap.
- `src/preload/index.ts` exposes exactly `window.styx` as typed by `StyxApi` (`packages/core/src/ipc/api.ts`):
  `platform, env, window, command, snapshot, onDelta, onEvent, pty, theme`. No `ipcRenderer` leaks.
- `src/renderer/`: `app/` (shell, rail, nav, roots for main / pop-out / dock windows, `ScreenOutlet`), `state/`
  (mirrored store + ui-store), `keys/`, `overlays/`, `screens/<Screen>/`, `features/<area>/` (chat, workspace,
  tasks-board, changes, preview, design-canvas, new-task, palette, modals, grant-sheet, …).
- Renderer imports `@styx/ui`, `@styx/core`, `@styx/tokens` and UI libraries (React, Zustand, Monaco, xterm). Never
  `electron` or `node:*`.
- Frameless everywhere: mac `hiddenInset` traffic lights vs `titleBarOverlay` on Windows and Linux, chosen in
  `services/window-service.ts`. Linux packaging lives in `electron-builder.yml` (`linux`, `deb`) and `build/linux/`
  (the polkit action and the .deb install hooks).
- Dev switches: see the root CLAUDE.md (`STYX_FIXTURE`, `STYX_KEYCHAIN=memory`, `STYX_MFA`, `STYX_NOW`,
  `STYX_SCREEN`, `STYX_THEME`, `STYX_CHROME`, `STYX_USER_DATA`, …), read in `src/main/index.ts` and `src/preload`.
- e2e in `e2e/` (built app, `e2e/launch.ts`, fake CLIs in `e2e/fixtures/bin`). Visual references in
  `e2e/visual/__baseline__/app/` (the app's own, ADR-0027) with the prototype bakes beside them as history.
- Test time limits that a test sets itself go through `slow()` (`src/main/test-timeouts.ts`).

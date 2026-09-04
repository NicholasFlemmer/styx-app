# apps/desktop

Electron app. Three isolated trees: `src/main` (Node, source of truth), `src/preload` (contextBridge only), `src/renderer` (React, no Node).

- `src/main/ipc/commands/<domain>.ts` registers handlers for core commands; validate with the core zod schema before touching services.
- `src/main/services/` = db, git, pty, credential-vault, broker, providers, notifications, windows. Classes with injected deps, built once in `container.ts`. No singletons at import time.
- `src/main/store/` projects SQLite into the read model and publishes `store.delta` (seq-numbered, batched per tick) to every window; `store.snapshot` on connect or seq gap.
- `src/preload/index.ts` exposes exactly `window.styx = { platform, command, subscribe, pty, theme, window }`. No `ipcRenderer` leaks.
- `src/renderer/`: `app/` shell, `state/` mirrored + ui stores, `keys/` registry, `overlays/` stack, `screens/<Screen>/`, `features/` (chat, grant-sheet, palette, editor, terminal, modals, toast, titlebar, banners).
- Renderer imports only `@styx/ui`, `@styx/core`, `@styx/tokens`. Never `electron` or `node:*`.
- Frameless on both platforms; mac traffic lights (hiddenInset) vs win titleBarOverlay switch on `platform`.
- Dev switches: `STYX_FIXTURE=<name>` seeds a temp SQLite; `STYX_SCREEN=<screen>` opens a screen; `STYX_NOW=<ms>` freezes the clock; `STYX_KEYCHAIN=memory` in-memory vault.
- e2e in `e2e/`; visual baselines in `e2e/visual/__baseline__/` (baked from the prototype, committed).

---
name: run-app
description: Launch Styx in dev with a seeded fixture and open a specific screen; diagnose common startup failures (native ABI mismatch, missing fonts, locked SQLite, keychain prompts, stale broker socket).
argument-hint: '[fixture] [screen]'
allowed-tools: Bash(pnpm:*), Bash(lsof:*), Bash(ps:*), Bash(rm:*), Read
---

# Run app

`STYX_FIXTURE=${0:-demo} STYX_SCREEN=$1 STYX_KEYCHAIN=memory pnpm dev`

| Symptom                                                                                         | Fix                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_MODULE_VERSION` mismatch / `was compiled against a different Node.js version`             | `pnpm rebuild:native`                                                                                                                                     |
| `EADDRINUSE` / stale socket                                                                     | remove `/tmp/styx-<uid>/broker.sock`                                                                                                                      |
| Keychain prompt loop                                                                            | `STYX_KEYCHAIN=memory`                                                                                                                                    |
| Blank window                                                                                    | run with `--inspect` and read the renderer console; check CSP in `src/renderer/index.html`                                                                |
| Fonts fall back                                                                                 | `pnpm tokens:build` (copies woff2 from @fontsource)                                                                                                       |
| Electron binary missing                                                                         | `node node_modules/electron/install.js`                                                                                                                   |
| `TypeError: Cannot read properties of undefined (reading 'setPath')` / `electron.app` undefined | The shell inherits `ELECTRON_RUN_AS_NODE=1` (VS Code extension host). Run with `env -u ELECTRON_RUN_AS_NODE …`; the e2e launcher strips it automatically. |

---
name: release
description: Build and package Styx for mac (signed + notarized) and Windows (signed) with electron-builder; run the pre-release checklist.
disable-model-invocation: true
allowed-tools: Bash(pnpm:*), Bash(git tag:*), Bash(git log:*), Read
---
# Release
1. Pre-flight: `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e && pnpm visual`.
2. Bump versions; update `CHANGELOG.md`.
3. `pnpm package:mac` (hardened runtime, `build/entitlements.mac.plist`; notarytool env var names documented in `CLAUDE.local.md`, never in repo).
4. `pnpm package:win` (signtool / Azure Trusted Signing).
5. Smoke each artifact: launch, onboarding, spawn shell session, connect fixture target, biometric prompt appears.
6. Tag `vX.Y.Z`.

## Packaging notes (learned 2026-09-05)
- Only native modules (`better-sqlite3`, `node-pty`, `@napi-rs/keyring`, `ssh2`) stay external in `electron.vite.config.ts`; every other main-process dependency is bundled. A packaged app that `require()`s ESM-only packages (execa, chokidar) at runtime hangs before `app.whenReady`.
- `apps/desktop/package.json` declares `packageManager: pnpm@…` so electron-builder resolves the hoisted workspace `node_modules`; workspace packages are devDependencies (bundled by electron-vite), which keeps Storybook/Jest out of the bundle.
- Without a signing identity electron-builder ad-hoc signs; never pass `CSC_IDENTITY_AUTO_DISCOVERY=false` on Apple Silicon (an unsigned bundle inherits a broken `Electron` signature).
- Validate a build with `pnpm -F @styx/desktop package:mac:dir && pnpm -F @styx/desktop package:smoke` (Playwright boots `release/mac-arm64/Styx.app` with the demo fixture).
- Windows builds (NSIS, signtool, Windows Hello, named-pipe broker) are untested on this Mac host.

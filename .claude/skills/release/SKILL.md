---
name: release
description: Build and package Styx for mac (signed + notarized) and Windows (signed) with electron-builder; run the pre-release checklist.
disable-model-invocation: true
allowed-tools: Bash(pnpm:*), Bash(git tag:*), Bash(git log:*), Read
---
# Release
1. Pre-flight: `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e && pnpm visual`, then `pnpm release:preflight` (signing identity, notarytool, the `styx-notary` keychain profile or the CI API-key env, packaging inputs; it prints the fix for anything missing).
2. Bump versions; update `CHANGELOG.md`.
3. `pnpm package:mac` (hardened runtime, `build/entitlements.mac.plist`, `STYX_NOTARIZE=1` → `build/notarize.cjs` notarizes with the keychain profile locally or `APPLE_API_KEY*` in CI). Verify: `codesign -dv --verbose=2 release/mac-arm64/Styx.app` shows the Developer ID, `spctl -a -vv -t install release/mac-arm64/Styx.app` says accepted, `xcrun stapler validate` passes.
4. `pnpm package:win` (builds the CLI too; signs when `CSC_LINK`/`CSC_KEY_PASSWORD` point at a Windows certificate).

CI: `.github/workflows/release.yml` runs both on a `v*` tag and drafts a GitHub release with the artifacts (secrets listed at the top of that file).
5. Smoke each artifact: launch, onboarding, spawn shell session, connect fixture target, biometric prompt appears.
6. Tag `vX.Y.Z`.

## Packaging notes (learned 2026-09-05)
- Only native modules (`better-sqlite3`, `node-pty`, `@napi-rs/keyring`, `ssh2`) stay external in `electron.vite.config.ts`; every other main-process dependency is bundled. A packaged app that `require()`s ESM-only packages (execa, chokidar) at runtime hangs before `app.whenReady`.
- `apps/desktop/package.json` declares `packageManager: pnpm@…` so electron-builder resolves the hoisted workspace `node_modules`; workspace packages are devDependencies (bundled by electron-vite), which keeps Storybook/Jest out of the bundle.
- Without a signing identity electron-builder ad-hoc signs; never pass `CSC_IDENTITY_AUTO_DISCOVERY=false` on Apple Silicon (an unsigned bundle inherits a broken `Electron` signature).
- Validate a build with `pnpm -F @styx/desktop package:mac:dir && pnpm -F @styx/desktop package:smoke` (Playwright boots `release/mac-arm64/Styx.app` with the demo fixture).
- Windows builds (NSIS, signtool, Windows Hello, named-pipe broker) are untested on this Mac host.

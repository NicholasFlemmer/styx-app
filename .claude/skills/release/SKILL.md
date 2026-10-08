---
name: release
description: Release a new Styx version through CI (styx-app release.yml → draft → publish.yml) and check it end to end.
disable-model-invocation: true
allowed-tools: Bash(pnpm:*), Bash(gh:*), Bash(git log:*), Read
---

# Release

Releases are built and published by CI on the public repo (NicholasFlemmer/styx-app), never from a laptop.

1. **Bump** `version` in `apps/desktop/package.json` (every release needs a new number; the feed refuses a version it
   already serves) and land it. `mirror.yml` pushes it to styx-app's `sync` branch; `sync-pr.yml` opens a pull
   request that merges itself once CI passes (about 35 minutes). Wait for that merge before step 2.
2. **Start the release**: `gh workflow run release.yml -R NicholasFlemmer/styx-app -f version=X.Y.Z`
   (or push a `vX.Y.Z` tag to styx-app). `verify` checks the version, waits for CI on that exact commit to pass,
   and tags it. Mac (signed + notarized, retried on network errors), Windows and Linux build in parallel; `draft`
   attaches every installer and feed file to a **draft** release.
3. **Review the draft** on styx-app › Releases. Only the owner presses **Publish release**: that is the gate.
4. **Publishing** runs `publish.yml`: the update feed (installers first, feed files last, keyless upload through
   Workload Identity), a check that all three feeds serve the new version, then the Homebrew cask bump in
   NicholasFlemmer/homebrew-styx.
5. **Check**: `curl -s https://storage.googleapis.com/styx-desktop-releases/mac/latest-mac.yml | head -1`, and an
   installed copy shows "Update available" within 30 minutes.

If a step fails, fix the cause, bump nothing, and re-run the failed jobs (a draft can be deleted and `release.yml`
re-run for the same version until it is published).

## Local builds (debugging only)

`pnpm release:preflight`, then `pnpm package:mac` (notarizes with the `styx-notary` keychain profile) or
`pnpm -F @styx/desktop package:mac:dir && pnpm -F @styx/desktop package:smoke` for an unsigned check.
`pnpm release:publish` still uploads a local `release/` folder through the `gcloud` shim, for emergencies only.

## Packaging notes (learned 2026-09-05)

- Only native modules (`better-sqlite3`, `node-pty`, `@napi-rs/keyring`, `ssh2`) stay external in `electron.vite.config.ts`; every other main-process dependency is bundled. A packaged app that `require()`s ESM-only packages (execa, chokidar) at runtime hangs before `app.whenReady`.
- `apps/desktop/package.json` declares `packageManager: pnpm@…` so electron-builder resolves the hoisted workspace `node_modules`; workspace packages are devDependencies (bundled by electron-vite), which keeps Storybook/Jest out of the bundle.
- Without a signing identity electron-builder ad-hoc signs; never pass `CSC_IDENTITY_AUTO_DISCOVERY=false` on Apple Silicon (an unsigned bundle inherits a broken `Electron` signature).
- Windows installers are named `Styx-Setup-<version>.exe` (no spaces: GitHub renames spaces in release assets).

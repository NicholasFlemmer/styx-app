# Styx

Desktop app (macOS, Windows, and Linux in beta; Electron + React) that runs coding agents (Claude Code, Codex, Gemini CLI, Cursor
agent, shell) on many projects at once. Each task is a **lane**: one agent session on its own git worktree and branch,
with its chat, changes, preview, checks and access. Agents reach deploy/server targets (Vercel, AWS, GCP, Supabase,
GitHub, SSH) only through scoped, expiring grants, and every request, grant, use and revoke goes into an append-only
audit log.

Open source under Apache-2.0. The hosted accounts/usage service and the marketing material live in a separate private
repo and are not part of this tree. The app works fully without them: sign-in is optional and gates nothing, builds
from source never send usage counts (`sendUsage` is on only for packaged, non-fixture builds or when
`STYX_API` is set; see `apps/desktop/src/main/index.ts`), and `STYX_API` / `DEFAULT_API` in `apps/desktop/src/main/services/account-service.ts`
point a fork at its own service.

This file is for coding agents and people alike. [CONTRIBUTING.md](CONTRIBUTING.md) covers the PR flow,
[SECURITY.md](SECURITY.md) how to report vulnerabilities.

## Where truth lives

1. **The code**, then **`docs/adr/`** (decisions with rationale; read ADR-0027 and ADR-0028 before UI work). Numbers
   run to 0029; the next is 0030 (ADR-0024 is filed as `0020-agent-clis-…md`).
2. **`docs/handoff-discrepancies.md`**: one row per deliberate departure from the original handoff or from
   established behaviour (`# | Where | Prototype | Spec | Resolution`). Add a row (next number after the last) when you
   change what a screen shows, a flow, a default or a rule the handoff states; name the files touched and the
   reason. Don't renumber or rewrite old rows: supersede them with a new one.
3. **`design/handoff/`**: the original design system, no longer the feature spec. Still binding: token values
   (`styx-tokens.css`, mirrored into `packages/tokens`), square corners, no shadows or gradients, 1px `--tx` borders
   on floating surfaces, the `data-inv`/`data-on` selection vocabulary, motion timings, Archivo + JetBrains Mono.
   Historical: the prototype's screen layouts, 10px uppercase labels and pixel sizes, which ADR-0027 replaced. The
   spec (`Styx Spec.dc.html`) is background for behaviour; where code, ADRs or the discrepancy log disagree, they
   win. `Wireframes.dc.html`, `support.js`, `doc-page.js` are viewer history: never port. `/spec-lookup` reads it.
4. **`design/next/`**: approved HTML mockups for the lane-centred UI (ADR-0027/0028). New screens or interaction
   models start as a mockup here, reviewed before building.
5. Also: `docs/state-machines.md`, `docs/research/agent-parity.md` (runner protocols), `docs/plan.md` (original
   build plan, partly historical), `.planning/` (local roadmap state, gitignored here; `STATE.md` is tool-owned).

## Monorepo map (pnpm workspaces)

- `apps/desktop`: Electron app. See `apps/desktop/CLAUDE.md`.
  - `src/main`: source of truth. `container.ts` wires everything; `services/` (sessions, git, lanes, land/publish,
    checkpoints, grants, audit, preview/run, design, devices, updates, …); `agents/` (one file per agent CLI);
    `providers/` (one adapter per target); `ipc/commands/` (handlers by domain); `broker/host.ts`; `db/` (drizzle
    schema, SQL migrations, seed); `store/` (read-model projection + delta publisher).
  - `src/preload/index.ts`: the `window.styx` bridge (shape: `StyxApi` in `packages/core/src/ipc/api.ts`).
  - `src/renderer`: React 19. `app/` shell + rails, `screens/<Screen>/`, `features/<area>/`, `state/` (mirrored
    store + ui-store), `overlays/`, `keys/`.
  - `e2e/`: Playwright over Electron (`*.spec.ts`), `visual/`, `sim/` (long user simulations), `readme/` (README media).
- `apps/website`: Next.js 16 static site (port 3100). Same tokens; plan in `apps/website/DESIGN.md`.
- `packages/core`: domain model, zod schemas, session/grant machines, policy engine, selectors, IPC contract,
  `copy.ts`. Pure: no Electron, DOM or I/O.
- `packages/ui`: component library (CSS Modules + tokens) with Storybook.
- `packages/tokens`: `tokens.json` → generated CSS/TS, bundled fonts.
- `packages/broker`: local broker protocol + `styx mcp` (the tools agents call).
- `packages/cli`: the `styx` CLI and provider shims (`gh`, `vercel`, `aws`, `gcloud`, `supabase`, `ssh`).

## Commands

Node ≥ 22, pnpm 10 (`corepack enable`). Run one package with `pnpm -F <name> <script>`.

- Install: `pnpm install` (postinstall rebuilds better-sqlite3/node-pty for Electron), then
  `node node_modules/electron/install.js` once, then `pnpm tokens:build`.
- Dev: `pnpm dev`. Switches (main/preload read them): `STYX_FIXTURE=demo|empty|error` (seeds a temp userData; real
  data untouched), `STYX_KEYCHAIN=memory`, `STYX_MFA=auto|deny`, `STYX_NOW=<ms>`, `STYX_SCREEN=<state>`,
  `STYX_THEME=dark|light|system`, `STYX_CHROME=mac|win`, `STYX_USER_DATA=<dir>`, `STYX_FIXTURE_RESET=1`,
  `STYX_DEMO_REPOS=0`, `STYX_API=<url>`, `STYX_UPDATE_URL=<feed>`.
- Build: `pnpm build` (e2e, visual and readme recordings launch the built `apps/desktop/out`).
- Typecheck: `pnpm typecheck`. Lint: `pnpm lint`. Format: `pnpm format`.
- Unit tests: `pnpm test` (all vitest projects) or `pnpm -F @styx/core test` (`@styx/desktop`, `@styx/ui`,
  `@styx/broker`, `@styx/cli`, `@styx/tokens`, `@styx/website`). Live checks (real catalogue, IDE detection):
  `STYX_LIVE=1`.
- e2e: `pnpm e2e` (`pnpm e2e -- --grep a11y` to filter). Packaged smoke: `pnpm -F @styx/desktop package:smoke`.
- Visual: `pnpm visual` compares against `e2e/visual/__baseline__/app/` (else the prototype baselines).
  `STYX_VISUAL_UPDATE=1 pnpm visual` re-takes the app references after a reviewed change; per-state ratios:
  `pnpm -F @styx/desktop visual:report`. `pnpm visual:baseline` re-bakes the prototype history only.
- Storybook: `pnpm storybook`; `pnpm storybook:test` builds it and runs every story through axe.
- Package: `pnpm package:mac` / `pnpm package:win` / `pnpm package:linux` (AppImage + .deb; build on Linux). Unsigned
  dir builds: `pnpm -F @styx/desktop package:mac:dir` (also `:win:dir`, `:linux:dir`).
- Public repo: STYX main reaches NicholasFlemmer/styx-app as a pull request from its `sync` branch (`mirror.yml` here,
  `sync-pr.yml` there) that merges itself once CI passes; contributors' merged pull requests flow back into STYX.
- Release: CI only. Bump `apps/desktop/package.json`, then run `release.yml` on styx-app (it waits for green CI,
  builds signed Mac + Windows + Linux into a draft release); publishing the draft runs `publish.yml` (update feed,
  Homebrew cask). See `.claude/skills/release/SKILL.md`.
- README media: `pnpm -F @styx/desktop readme:gif` (after `pnpm build`; needs ffmpeg).
- DB: `pnpm db:generate` (drizzle-kit, then hand-add CHECKs/triggers; see `/db-migration`), `pnpm db:migrate`,
  `pnpm db:seed`. Tokens: `pnpm tokens:build`. Native ABI trouble: `pnpm rebuild:native`.

## Architecture rules

- Main is the source of truth (ADR-0006). The renderer holds a read-only mirrored Zustand store fed by
  `store.snapshot` + seq-numbered delta batches, plus a ui-store for view state. No optimistic domain updates.
- The renderer never touches fs, git, child processes, network or secrets, and never imports `electron` or `node:*`.
- Every mutation is a named command: zod schema in `packages/core/src/ipc/contract.ts`, handler in
  `apps/desktop/src/main/ipc/commands/<domain>.ts`, called as `window.styx.command(name, input)`. Handlers return
  `{ ok, value } | { ok: false, error }`, never throw across IPC. New command: `/ipc-command`.
- Session and Grant machines live in `packages/core/src/machines`: exhaustive transition tables, effects as data,
  time injected (`ctx.now`; no `Date.now()` in core, main uses `clock.ts`). Change them via `/state-machine-change`.
- Policy evaluation is pure (`packages/core/src/policy`); main applies the result and audits it.
- Business logic goes in core (selectors, machines, policy) or main services, not in React components or IPC handlers.
- IDs are ULIDs with branded types (`packages/core/src/ids.ts`); timestamps are epoch ms. Never join by names.
- `.styx/project.json` is versioned (`version: 1`) and zod-validated (`packages/core/src/project-file.ts`); never
  holds secrets.
- Agent runners (ADR-0010/0016/0017): Claude Code over `stream-runner.ts`, Codex over `codex app-server`
  (`app-server-runner.ts`), Gemini and Cursor over ACP (`acp-runner.ts`; Cursor falls back to `--print`
  stream-json), shell over a pty; `runner-mux.ts` routes them. Codex's TUI cannot take messages through a pty, so
  never route Codex there. New agent: `docs/contributing/adding-an-agent.md`.
- Lanes: one session = one worktree on `agent/<name>-<n>` (`branchPrefix`). Lane services: `lane-sync-service`
  (keep current with base), `lane-ledger-service`, `land-service`, `merge-resolve-service`, `publish-service`,
  `checkpoint-service` (turns as hidden refs under `refs/styx/checkpoints/`). Merge base in, never rebase (it would
  orphan checkpoints).

## Security invariants

- Secrets live only in the OS keychain (`@napi-rs/keyring`, `services/credential-vault.ts`) behind `credentialRef`:
  never in SQLite, logs, IPC payloads, deltas, renderer state, fixtures, project.json or the repo.
- `audit_entries` is append-only (triggers + `prev_hash`/`hash` chain); write only via `AuditService.append`. Revoke
  inserts a new row. Every request/grant/use/revoke/deny is audited with actor, session, worktree and trigger.
- Prod ∧ write/deploy/delete needs OS authentication (Touch ID / Windows Hello / polkit on Linux, ADR-0029) before
  issuance. `requireMfa` is
  recomputed in `GrantService` from DB rows, never taken from the renderer.
- Agents get scoped, short-lived tokens or env for the grant's lifetime only; SSH gets a forwarded agent socket
  (`SSH_AUTH_SOCK`), never a key file. Broker connections are bound to one session.
- Everything an agent supplies that gets persisted passes `redact()` / `redactArgv()` first. Scope heuristics fail
  closed. Details: `.claude/rules/security.md`. Touching broker, cli, vault, providers, grants or MFA: run the
  `security-reviewer` agent. New target: `docs/contributing/adding-a-target.md` and `/provider-adapter`.

## Design rules

- Colours only from tokens: `--bg --s1 --s2 --ln --tx --mu --ac --acx --act --add --term --termtx --dim`, plus
  ADR-0027's `--agent-*` (a small square beside an agent's name only), `--paper-*` (result cards) and `--del`.
  `--act` is accent-as-text; never `--ac` as text on light. Sizes and spacing from `packages/tokens/tokens.json` vars.
- `border-radius: 0`, no `box-shadow`, no gradients, no hover transitions. Floating surfaces: `1px solid var(--tx)`.
- Selection: `data-inv="true"` current, `data-on="true"` accent/armed. No `.active`/`.selected` classes.
- Motion: sheet 160ms slide, modal 120ms fade, toast 160ms slide; reduced motion → fades (`@styx/tokens` motion.css).
- Type (ADR-0027 §6): sentence-case labels (no uppercase tracked labels), 14px body, Archivo 600 headings (never
  wide Archivo), JetBrains Mono only for code, paths and branches. Lime marks only the move that is the person's.
- User-facing strings come from `packages/core/src/copy.ts`; plain words, sentence case.
- Full CSS rules: `.claude/rules/css-tokens.md` (the `check-design-css` hook enforces the basics).

## Coding conventions

- TS strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` (`tsconfig.base.json`). No `any`, no `!` in
  core, `satisfies` over `as`, discriminated unions over enums, type-only imports. Named exports only (config,
  stories, Next route files excepted).
- zod at every boundary: IPC, SQLite rows out, project.json, broker messages, provider and CLI responses.
- Files `kebab-case.ts`; components `PascalCase.tsx` + `.module.css` + `.stories.tsx` (ui) + `.test.tsx`; tests sit
  next to source. Errors are typed results in core, thrown only at process edges.
- Spawn agent CLIs through `services/spawn-cli.ts` (Windows `.cmd` shims, process-tree kill), not raw `spawn`.
- No Tailwind, CSS-in-JS, icon fonts or a second state library.

## Testing

- core: table-driven, deterministic, fixtures from `packages/core/src/fixtures/demo.ts`. 100% coverage is enforced on
  `machines/`, `policy/`, `selectors/`, `arcade/` (`packages/core/vitest.config.ts`); one row per (state, event)
  pair including invalid ones.
- desktop main: build services with `makeTestApp()` (`src/main/test-support.ts`): in-memory vault, fake CLIs and
  MFA, no simulator tools unless a test passes `deviceExec`/`deviceWhich`. Every command gets a contract test. Never
  hit real providers, the real keychain or the network.
- Timeouts: vitest stretches limits on CI (60s) and Windows (30s); a test that sets its own limit wraps it in
  `slow(ms)` from `apps/desktop/src/main/test-timeouts.ts` (×4 on CI). Playwright allows 180s per test on CI.
- ui: a story per variant × state (Storybook axe gate via `pnpm storybook:test`), testing-library tests for
  keyboard, focus and aria.
- e2e: `e2e/launch.ts` starts the built app with `STYX_E2E=1`, a temp `STYX_USER_DATA`, `STYX_FIXTURE=demo`,
  `STYX_KEYCHAIN=memory`, a fixed `STYX_NOW`, and fake `claude`/`codex`/`gemini`/`gh`/`adb`/`xcrun` from
  `e2e/fixtures/bin` first on PATH. Screens set `[data-screen-ready]` (inside the Suspense boundary) when painted.
- CI (`.github/workflows/ci.yml`) runs on macOS, Windows and Linux (e2e under `xvfb-run`): install, Electron unpack,
  tokens, typecheck, lint, test, build, Storybook axe, e2e, and a packaged-app smoke. Keep all three green.
- Before calling a task done: `pnpm typecheck && pnpm lint && pnpm -F <package> test`; UI changes also `pnpm e2e`,
  `pnpm visual` and the story.

## Gotchas

- **Three platforms, two layouts** (ADR-0029): `Platform` (`darwin | win32`) is layout and keys, and Linux renders
  win32-style; words use `CopyPlatform` (`platformCopy`, `useCopyPlatform()`), where Linux has its own. In main,
  `platform === 'darwin' ? mac : win` silently gives Linux the Windows branch: write `win32 ? … : posix`, or handle
  `linux` explicitly.
- **Electron starts as plain Node**: the shell has `ELECTRON_RUN_AS_NODE` set (VS Code terminals). The scripts
  strip it; launch Electron by hand with `env -u ELECTRON_RUN_AS_NODE`.
- **`pnpm -s typecheck` can hide errors** in some shells. Verify per package and check the exit code:
  `pnpm -F @styx/desktop typecheck` (runs `tsc -p tsconfig.node.json` and `tsconfig.web.json`), likewise for others.
- **Fresh worktree**: no `node_modules`. `pnpm install --frozen-lockfile`, then `node node_modules/electron/install.js`
  in one process before vitest; otherwise test workers race the download and leave a half-extracted
  `node_modules/electron/dist` (move it aside and re-run the installer).
- **Demo fixture paths are literal** (`~/code/acme-shop`): a main test that starts a run or writes project settings
  must point the project at a temp dir, or `apps/desktop/~/code/…` appears in the repo.
- **Per-session UI state** (drafts, attachments) belongs in the ui-store keyed by session id: screens unmount.
- **Claude Code hooks** (`.claude/hooks/`): the secrets guard greps the command text and the staged diff, so write
  commit messages to a file (`git commit -F`) and expect merges carrying the redaction tests' fake tokens to be
  blocked; `check-design-css` reads `#110` in a comment as a hex colour (write "row 110").
- **Reading a failed run**: `<userData>/styx.db` (`sessions`, `transcript_messages`, `pending_asks`),
  `<userData>/logs/pty/<sessionId>.log`, and the main log (`~/Library/Logs/Styx/main.log` on a Mac). userData is
  `~/Library/Application Support/Styx` on a Mac; fixture runs log their temp userData on the `fixture` line.

## Tooling for agents

- Skills in `.claude/skills/`: `ipc-command`, `state-machine-change`, `db-migration`, `provider-adapter`,
  `ui-component`, `run-app`, `spec-lookup`, `visual-diff`, `release`; `port-screen` is from the prototype-port era.
- Reviewers in `.claude/agents/`: `security-reviewer`, `state-machine-auditor`, `a11y-reviewer`,
  `design-fidelity-reviewer`, `electron-native-debugger`.
- Path rules in `.claude/rules/` load for matching files (CSS tokens, IPC, security, testing).

## Don't

- Don't hand-edit `design/handoff/`, `.planning/STATE.md` or `apps/desktop/e2e/visual/__baseline__/` (regenerate
  baselines through the visual scripts).
- Don't write `.env*`, `*.pem`, `*.key`, `*.p12`, or commit fixtures with real tokens.
- Don't push to `main`, force-push, `git reset --hard`, `git clean` or `rm -rf`. Work on a branch and open a PR.
- Don't change UX silently: a new screen or flow needs a mockup in `design/next/`, an ADR for a real decision, and a
  discrepancy row.
- Don't skip the story, the test, or the visual check for UI work.

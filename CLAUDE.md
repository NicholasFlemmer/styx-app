# Styx

Local desktop app (macOS + Windows) for switching projects, supervising coding-agent sessions
(Claude Code, Codex, Gemini CLI, Cursor agent, shell) in an embedded Monaco + xterm workspace, and gating
agents' access to deploy/server targets (Vercel, AWS, GCP, Supabase, GitHub, SSH) through scoped, expiring
grants with an append-only audit log.

@design/handoff/README.md

## The handoff is the spec

`design/handoff/` is authoritative. Which file answers which question:

- Look, spacing, copy, states -> `Styx.dc.html` (pixel-final; screens tagged `data-screen-label`)
- Object model, state machines, layout, keyboard, platform, components, a11y, copy -> `Styx Spec.dc.html` (§1-§11)
- Token values -> `styx-tokens.css` (verbatim) / `styx-tokens.json` (sizes, motion, shortcuts)
- Why -> `UX Research Memo.dc.html`. `Wireframes.dc.html`, `support.js`, `doc-page.js` are history / viewer runtime: never port.

Use `/spec-lookup <topic>` to read the HTML with tags stripped. Copy §10 strings verbatim via `packages/core/src/copy.ts`.
Decisions with rationale: `docs/adr/`. Progress: `.planning/STATE.md` (owned by `/gsd:*`).

## Monorepo map (pnpm workspaces)

- `apps/desktop` — Electron: `src/main` (source of truth: SQLite, git, pty, keychain, broker), `src/preload` (typed bridge), `src/renderer` (React 19)
- `packages/core` — domain types, zod schemas, session/grant machines, policy engine, selectors, IPC contract. No Electron, DOM, I/O.
- `packages/ui` — component library + Storybook. Plain CSS Modules, tokens only.
- `packages/tokens` — tokens css/json + bundled fonts. `packages/broker` — broker protocol + `styx mcp`. `packages/cli` — `styx` CLI + provider shims.

## Commands

- `pnpm dev` (`STYX_FIXTURE=demo` seeds a temp DB) · `pnpm build` · `pnpm package:mac` / `package:win` · `pnpm rebuild:native`
- `pnpm test` · `pnpm test -F @styx/core` · `pnpm e2e` · `pnpm visual` (screenshots vs prototype) · `pnpm visual:baseline`
- `pnpm typecheck` · `pnpm lint` · `pnpm format` · `pnpm storybook` · `pnpm storybook:test` · `pnpm tokens:build`
- `pnpm db:generate` / `db:migrate` / `db:seed`

## Architecture rules

- Main process is the source of truth. Renderer holds a read-only mirrored Zustand store fed by snapshot + sequenced deltas.
- Renderer never touches fs, git, child processes, network, or secrets. Not even in dev.
- Every mutation is a named command: zod schema in `packages/core/src/ipc/contract.ts`, handler in `apps/desktop/src/main/ipc/commands/`, called as `window.styx.command(name, input)`. No ad-hoc IPC strings.
- Session and Grant state machines live in `packages/core/src/machines`; transitions are exhaustive tables, effects are data, time is injected (`ctx.now`).
- Policy evaluation is pure (`packages/core/src/policy`); main applies the result and logs it.
- IDs are ULIDs (branded types in `packages/core/src/ids.ts`); timestamps are epoch ms numbers everywhere. Never join by names.
- `.styx/project.json` is versioned and zod-validated; secrets are never written there.

## Design fidelity (hard requirement)

- Use `--bg --s1 --s2 --ln --tx --mu --ac --acx --act --add --term --termtx --dim` and the size/space vars. No raw hex, no px that exists as a token.
- `border-radius: 0`, no `box-shadow`, no gradients. Floating surfaces get `1px solid var(--tx)`.
- Selection vocab: `data-inv="true"` = current/inverted; `data-on="true"` = accent/armed. No `.active` classes.
- Hover is instant. Sheet 160ms slide, modal 120ms fade, toast 160ms slide; reduced-motion → fades only.
- Archivo (UI) + JetBrains Mono (code), bundled from `@styx/tokens`. Uppercase via `text-transform`. Square dots and checkboxes. Tabular numerals, zero-padded only in counters.
- Sizes from tokens.json (titlebar 38, rail 56, nav 168, files 200, chat 360, sheet 360, drawer 380 …). Window min 1100×680, no breakpoints.
- Verify every ported screen with `/visual-diff <screen>` before calling it done.

## Security invariants

- Secrets only in the OS keychain (`@napi-rs/keyring`) behind `credentialRef`. Never in SQLite, logs, IPC payloads, renderer state, fixtures, or the repo.
- `audit_entries` is append-only (triggers + hash chain). Revoke inserts a new row.
- Prod write/deploy/delete requires OS biometric before issuance; `requireMfa` is computed in main, never trusted from the renderer.
- Agents get scoped short-lived tokens or env for the grant lifetime only; SSH gets a forwarded agent socket, never a key file.
- Every request/grant/use/revoke/deny is audited with actor, session, worktree, and triggering command.

## Coding conventions

- TS strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. Named exports only (config and story files excepted).
- zod at every boundary: IPC, SQLite rows out, project.json, broker messages, provider responses.
- Files `kebab-case.ts`; components `PascalCase.tsx` + `.module.css` + `.stories.tsx` + `.test.tsx`; tests next to source.
- Discriminated unions over enums; `satisfies` over `as`; no `any`; no `!` in core. Errors are typed results in core, thrown only at process edges.

## Testing expectations

- core: 100% branch coverage on machines, policy, selectors; table-driven. IPC: contract test per command with in-memory SQLite.
- ui: story per variant/state, testing-library test for keyboard/focus, axe clean.
- Screens: Playwright Electron e2e over `STYX_FIXTURE=demo`; visual diff vs prototype per theme × chrome.
- Run `pnpm typecheck && pnpm test -F <package>` before declaring a task done.

## Don't

- Don't invent UI or "improve" the prototype. Don't add Tailwind, CSS-in-JS, icon fonts, or a second state library.
- Don't put business logic in React components or IPC handlers.
- Don't write `.env*`, `*.pem`, `*.key`; don't commit fixtures with real tokens.
- Don't `git push`, `git reset --hard`, `rm -rf`, or hand-edit `.planning/STATE.md` or `design/handoff/`.
- Don't skip the story, the test, or the visual diff.

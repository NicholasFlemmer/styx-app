# Styx — Development Plan

## Context

`design_handoff_styx/` is a complete, high-fidelity design handoff for **Styx**: a local desktop app (macOS + Windows, Electron + React) that switches projects in one window, embeds Monaco + xterm, supervises coding-agent sessions (Claude Code, Codex, Gemini CLI, Cursor agent, shell), and gates agents' access to deploy/server targets (Vercel, AWS, GCP, Supabase, GitHub, SSH) through scoped, expiring grants with an audit log. `/Users/nic/STYX` contains nothing else: this is greenfield.

The handoff is authoritative. `Styx.dc.html` is pixel-final; `Styx Spec.dc.html` §1–§11 gives the object model, state machines, layout, screens, palette, keyboard map, platform rules, component inventory, accessibility and copy; `styx-tokens.css/json` are the tokens (use verbatim). `support.js`, `doc-page.js`, `Wireframes.dc.html` are viewer runtime / history and are never ported. The prototype fakes the whole grant lifecycle with one enum fanned across ~12 render sites and joins by display strings; the real app needs ids, a real Grant entity, structured audit rows and timestamps.

This plan covers: decisions on the handoff's open questions, monorepo + software architecture, database schema, the agent-access broker, renderer + component library, the Claude Code scaffolding (CLAUDE.md, skills, subagents, hooks, settings, MCP), and a 13-phase roadmap in the installed gsd plugin's `.planning/` format.

---

## 1. Decisions (assumptions taken; each becomes an ADR in Phase 1)

| #        | Decision                                                                                                                                                                                                                                                                                                                                                       | Rationale                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| ADR-0001 | **Grant transport = local broker.** Main runs a JSON-RPC server on a per-user Unix socket / named pipe. Agents reach it via (a) a `styx mcp` stdio MCP server auto-injected into each CLI's MCP config and (b) a `styx` CLI + provider shims (`vercel`, `gh`, `aws`, `gcloud`, `supabase`, `ssh`) prepended to PATH. Output-sniffing of failed auth is not v1. | Memo open question #1. Broker is deterministic, auditable, captures the triggering command. |
| ADR-0002 | **No LSP in Monaco for v1.** Syntax highlighting + editing; "Open in {IDE}" is the escape hatch.                                                                                                                                                                                                                                                               | Spec §11 + memo.                                                                            |
| ADR-0003 | **Sessions are per-project, per-worktree.** No cross-repo sessions.                                                                                                                                                                                                                                                                                            | Memo open question #2.                                                                      |
| ADR-0004 | **WSL optional.** Windows default shell PowerShell; per-project `shell.windows: wsl` only changes the pty shell.                                                                                                                                                                                                                                               | Memo open question #5.                                                                      |
| ADR-0005 | **`.styx/project.json` v1 schema** (see §4). Targets identified by `(provider, env, name)`; `credentialRef` is machine-local in SQLite, never in the file.                                                                                                                                                                                                     | Spec gives no schema.                                                                       |
| ADR-0006 | **Main process is the single source of truth.** SQLite (better-sqlite3 + Drizzle). Renderer holds a mirrored read model (Zustand) fed by snapshot + sequenced deltas; every mutation is a zod-validated command. No optimistic domain updates (only the grant sheet closes eagerly).                                                                           | Kills the prototype's fan-out bug class.                                                    |
| ADR-0007 | **Secrets only in OS keychain** via `@napi-rs/keyring` (N-API, no Electron rebuild). SQLite stores `credential_ref` only.                                                                                                                                                                                                                                      | README/memo invariant.                                                                      |
| ADR-0008 | **Styling = CSS Modules + cascade layers**, plain CSS with token custom properties; `data-inv`/`data-on` in a `state` layer that beats component rules without `!important`. No Tailwind/CSS-in-JS.                                                                                                                                                            | Zero runtime, same CSS in Storybook/Playwright.                                             |
| ADR-0009 | **Storybook 9 (Vite builder)** over Ladle, for axe addon + test-runner.                                                                                                                                                                                                                                                                                        |                                                                                             |
| ADR-0010 | **Session runners:** `stream` (headless stream-json) for `claude` and `cursor`; `pty` (TUI in xterm) for `codex`, `gemini`, `shell`. Promote after spike.                                                                                                                                                                                                      | Only Claude Code and cursor-agent clearly support bidirectional stream-json today.          |
| ADR-0011 | **Timestamps are epoch ms (`number`) everywhere** (SQLite INTEGER, store, IPC). IDs are ULIDs. Never join by names.                                                                                                                                                                                                                                            |                                                                                             |
| ADR-0012 | **Fidelity policy:** where prototype and spec disagree, prototype wins for visuals, spec for behavior; log disagreements in `docs/handoff-discrepancies.md`.                                                                                                                                                                                                   |                                                                                             |
| ADR-0013 | **Roadmap lives in gsd's `.planning/`** (`PROJECT.md`, `ROADMAP.md`, `STATE.md`, phase PLAN.md) so `/gsd:plan-phase` and `/gsd:execute-phase` can drive execution.                                                                                                                                                                                             | gsd plugin is installed on this machine.                                                    |

---

## 2. Monorepo layout

```
STYX/
  CLAUDE.md  .claude/{settings.json,rules/,skills/,agents/,hooks/}  .mcp.json  .planning/  docs/adr/
  design/handoff/            # git mv of design_handoff_styx/ (unchanged contents)
  apps/desktop/
    electron.vite.config.ts  electron-builder.yml
    src/main/      db/{schema.ts,migrations/*.sql,migrate.ts}  services/  providers/  agents/  broker/  ipc/  container.ts  index.ts
    src/preload/index.ts
    src/renderer/  app/  state/  keys/  overlays/  screens/  features/  styles/  main.tsx  index.html
    e2e/           *.spec.ts  visual/{bake-baseline.ts,screens.spec.ts,__baseline__/}
    resources/     templates/{node,python,go,rust,static}  cli/styx.js
  packages/core/     model/ machines/ policy/ selectors/ ipc/ deltas.ts readModel.ts project-file.ts copy.ts keys/ diff/ fixtures/
  packages/ui/       styles/{layers,reset,type,state}.css  primitives/ layout/ feedback/ overlay/ chrome/ message/ hooks/  .storybook/
  packages/tokens/   tokens.json  scripts/build.ts  css/{tokens,fonts,motion}.css  fonts/*.woff2  src/generated.ts
  packages/broker/   protocol.ts  mcp-stdio.ts  ssh-agent.ts
  packages/cli/      styx.ts (wrap|mcp|hook|request|status|targets|git-credential)  wrappers/*.ts
  packages/native-winhello/   napi-rs addon for Windows Hello UserConsentVerifier (Phase 8)
```

Tooling: pnpm workspaces (`node-linker=hoisted`), TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), electron-vite, electron-builder + `@electron/rebuild`, eslint + prettier, vitest, @testing-library/react, Playwright (`_electron`), Storybook 9, drizzle-kit, GitHub Actions matrix mac + win.

Key packages: `electron`, `electron-vite`, `better-sqlite3`, `drizzle-orm`, `node-pty`, `@xterm/xterm` (+fit, webgl, search), `monaco-editor`, `@napi-rs/keyring`, `zod`, `zustand` (+immer), `ulid`, `@modelcontextprotocol/sdk`, `execa`, `chokidar@4`, `parse-diff`, `ssh2`, `jose`, `@aws-sdk/client-sts`, `@msgpack/msgpack`, `electron-log`, `@tanstack/react-virtual`.

Native gotchas to bake into Phase 1: `electron-builder install-app-deps` rebuilds better-sqlite3 + node-pty; `asarUnpack: ["**/*.node","node_modules/node-pty/**","resources/cli/**"]`; node-pty `spawn-helper` must be signed; drizzle migrations imported as raw strings via `import.meta.glob('./migrations/*.sql', {query:'?raw', eager:true})`; Monaco workers via Vite `?worker` imports with `worker.format:'es'` and CSP `worker-src 'self' blob:`; resolve login-shell PATH once (`$SHELL -ilc 'echo $PATH'`) because GUI apps get a stripped PATH.

---

## 3. Database (SQLite, main process)

`app.getPath('userData')/styx.db`, `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`. IDs TEXT ULID; timestamps INTEGER ms; enums TEXT + CHECK (added in hand-edited SQL migrations, since drizzle-kit does not emit CHECK for SQLite). Drizzle schema in `apps/desktop/src/main/db/schema.ts` mirrors the SQL 1:1.

### Tables

```sql
meta(key PK, value)                       -- schema_version, app_version, machine_id
projects(id PK, name, path UNIQUE, initials, rail_order, settings_json, settings_mtime, created_at, last_activity_at, removed_at)
repos(id PK, project_id UNIQUE FK, default_branch NULLABLE (0003: NULL = plain folder, no git), remotes_json, ahead, behind, fetched_at, line_endings CHECK(auto|lf|crlf), long_paths)
worktrees(id PK, repo_id FK, branch NULLABLE (0003: NULL only on a plain folder's main worktree), path UNIQUE, is_main, owner_kind CHECK(user|session), owner_session_id FK, base_commit, head_commit,
          added, removed, files_changed, pr_number, pr_state CHECK(draft|open|merged|closed), pr_url, conflict_file, conflict_against,
          merged_at, created_at, archived_at, UNIQUE(repo_id, branch))
sessions(id PK, project_id FK, worktree_id FK, agent CHECK(claude|codex|gemini|cursor|shell), runner CHECK(pty|stream), model,
         state CHECK(idle|working|needs-you|done|paused), paused_reason CHECK(cli-missing|conflict|auth-expired), note, first_message,
         auto_approve_edits, may_request_targets, notify_when_needs_me, broker_token_hash, pid, exit_code,
         started_at, last_activity_at, ended_at, archived_at,
         CHECK((state='paused')=(paused_reason IS NOT NULL)), CHECK((state='done')=(ended_at IS NOT NULL)))
transcript_messages(id PK, session_id FK, seq, kind CHECK(user|agent|file-list|decision|access-request|system), body, payload_json,
                    ask_id FK, created_at, UNIQUE(session_id, seq))
pending_asks(id PK, session_id FK, kind CHECK(grant|plan|decision|question), grant_id FK, payload_json, state CHECK(open|resolved|cancelled),
             resolution_json, position, broker_request_id, created_at, resolved_at, CHECK((kind='grant')=(grant_id IS NOT NULL)))
targets(id PK, project_id FK, provider CHECK(vercel|aws|gcp|supabase|github|ssh), name, env CHECK(prod|staging|preview|scm),
        auth_method CHECK(oauth|key|ssh|cli) (0002 rebuilds `targets` with the widened CHECK), policy CHECK(ask-mfa|ask|always) DEFAULT 'ask', policy_source CHECK(app|project),
        credential_ref, config_json, health CHECK(ok|expired|unconnected), health_checked_at, expired_at, from_project_file, created_at,
        UNIQUE(project_id, provider, env, name))
grants(id PK, session_id FK NULLABLE, target_id FK, worktree_id FK, scope_json, scope_mask, duration CHECK(once|1h|session|always), reason,
       state CHECK(requested|active|denied|revoked|expired), requested_at, issued_at, expires_at, last_used_at, idle_expires_at, revoked_at,
       revoke_reason CHECK(user|expired|idle|session-end|once-used|target-removed|policy), policy_id FK, mfa_verified,
       decided_by CHECK(user|policy|target-policy|persistent-grant), cred_nonce)
grant_uses(id PK, grant_id FK, session_id FK, via CHECK(shim|get_credential|ssh-agent-sign|styx-cli), command, scope_used, exit_code, started_at, ended_at)
policies(id PK, ord UNIQUE, rule_json, rule_text, enabled, builtin_key UNIQUE, match_count_today, match_count_week, counters_reset_at, created_at)
audit_entries(id PK, seq UNIQUE, time, actor_kind CHECK(you|system|agent), actor_label,
              action CHECK(requested|granted|denied|used|revoked|expired|opened-pr|merged-pr|connected|disconnected|tested|policy-changed|exported),
              project_id, target_id, session_id, worktree_id, grant_id, policy_id,        -- no FKs: audit outlives rows
              target_label, session_label, worktree_label, agent, scope_json, duration, triggered_by, detail_json, prev_hash, hash)
  + TRIGGER audit_no_update / audit_no_delete → RAISE(ABORT)      -- append-only, hash-chained
agent_changes(id PK, session_id FK, worktree_id FK, file, hunk_hash, old_start, old_lines, new_start, new_lines, patch,
              status CHECK(pending|accepted|rejected|stale), first_seen_at, last_seen_at, decided_at, UNIQUE(worktree_id, hunk_hash))
ide_installs(id PK, kind CHECK(vscode|cursor|jetbrains|neovim), product, version, location, launcher, config_dir, is_fallback, imported_json, detected_at)
cli_installs(agent PK, binary, version, found, auth_state CHECK(signed-in|signed-out|unknown|n/a), capabilities_json, checked_at)
ui_state(key PK, value_json, updated_at)      app_settings(key PK, value_json, updated_at)
window_state(key PK, x, y, width, height, display_id, maximized, updated_at)        -- 'main' | 'popout:<sessionId>'
notifications(id PK, kind CHECK(needs-you|grant-result|error-banner|info), session_id, ask_id, project_id, title, body, meta,
              os_delivered, state CHECK(shown|later|acted|dismissed|resolved), banner_key UNIQUE, created_at, resolved_at)
```

Indexes: `sessions(project_id,state)`, partial `sessions(ended_at) WHERE archived_at IS NULL`, `pending_asks(session_id,position) WHERE state='open'`, partial `grants(target_id) WHERE state='active'`, `grants(expires_at) WHERE state='active'`, `audit_entries(time DESC)`, `audit_entries(target_id,time DESC)`, `agent_changes(worktree_id) WHERE status='pending'`.

### Semantics encoded

- **Session machine** (`packages/core/src/machines/session.ts`): events `start | ask | ask-resolved | finish | error(reason) | resolve | activity | quiet`. `needs-you` is left only when the open-ask queue is empty. `RetentionJob` (hourly) sets `archived_at` where `ended_at < now-7d`.
- **Grant machine** (`machines/grant.ts`): `requested → active` (policy auto, target policy `always`, persistent grant, or user +MFA when `env='prod' ∧ scope∩{write,deploy,delete}`), `requested → denied`, `active → revoked|expired` (expiresAt, idle, session end, user, once-used). `always` grants get `session_id=NULL` after issuance and are revocable from any lock glyph.
- **Queue**: head ask = `SELECT … FROM pending_asks WHERE session_id=? AND state='open' ORDER BY position LIMIT 1`. Only the head surfaces (sheet/board/inbox/toast); others show as "+n queued". Resolving promotes the next and re-notifies.
- **Target derived state** (query in read model, `now` injected): `unconnected` if no credential_ref → `expired` if health → `persistent` if active `always` grant → `open` (with `open_until = min(expires_at, idle_expires_at)`) if any live grant → else `locked`.
- **Migrations**: backup `styx.db` → `.bak-<version>` (keep 3), apply pending SQL in one transaction, refuse to open if DB is newer than the app.
- **Fixtures**: `packages/core/src/fixtures/demo.ts` = the prototype dataset (acme-shop/blog-v2/infra-tools/client-x/side-api; 8 sessions incl. Codex `needs-you` with a requested Supabase-prod write grant "migration 0042"; 5 targets; 3 policies; 5 audit rows; 3 pending hunks). `STYX_FIXTURE=demo` seeds a temp DB and creates real git repos under `~/code-styx-demo/`; `STYX_NOW` freezes the clock so ages read `2m/3m/9m`; `STYX_KEYCHAIN=memory` uses an in-memory vault.

---

## 4. `.styx/project.json` (committed, secret-free, versioned)

```jsonc
{
  "$schema": "https://styx.dev/schema/project.v1.json",
  "version": 1,
  "name": "acme-shop",
  "targets": [
    {
      "name": "Vercel",
      "provider": "vercel",
      "env": "prod",
      "authMethod": "oauth",
      "config": { "teamSlug": "acme", "project": "shop" },
      "policy": "ask-mfa",
    },
    {
      "name": "AWS acme-prod",
      "provider": "aws",
      "env": "prod",
      "authMethod": "key",
      "config": { "region": "us-east-1", "roleArn": "arn:aws:iam::123:role/styx-agent" },
    },
    {
      "name": "GitHub acme/shop",
      "provider": "github",
      "env": "scm",
      "authMethod": "oauth",
      "config": { "owner": "acme", "repo": "shop" },
      "policy": "always",
    },
  ],
  "agents": {
    "default": "claude",
    "model": null,
    "autoApproveEdits": false,
    "mayRequestTargets": true,
    "notifyWhenNeedsMe": true,
    "perAgent": {},
  },
  "policies": { "disabledBuiltins": [], "extra": [] },
  "worktrees": { "baseBranch": "main", "branchPrefix": "agent/", "location": "sibling" },
  "shell": { "windows": "powershell" },
  "lineEndings": "auto",
  "env": { "files": [".env.local"], "shareWithAgents": "per-grant" },
}
```

Zod `ProjectFileV1` in `packages/core/src/project-file.ts`; unknown keys preserved on rewrite. Effective settings = `deepMerge(builtinDefaults, app_settings, projectFile)`; keys from the file are marked `source:'project'` (drives the Settings reset affordance; reset deletes the key). `ProjectService.reconcileProjectFile` runs on add, on chokidar change, on checkout: upsert `targets` by `(project_id, provider, env, name)` with `from_project_file=1`; rows without a local `credential_ref` show as `unconnected` with a Connect action pre-filled.

**Trust gate (security audit H-1).** The file is repo-authored, so its grant policy — `policies.extra` and every `targets[].policy` — is advisory until accepted on this machine. Main keeps a per-project acceptance record in `ui_state` (`project-policy-accepted:<projectId>` = `{ hash, summary }`, sha256 of the canonical policy summary). While the file's current hash differs from the accepted one (a fresh clone, a new commit): `ProjectService.projectRules()` downgrades every `auto-approve` rule to `ask` (same id, so the audit still cites it) and drops `idle-expiry` rules; `reconcileProjectFile` does not copy `targets[].policy` onto the row (`policy_source` stays `app` with the app value); a persistent banner `project-policy:<projectId>` (notification kind `info`, copy `errors.projectPolicyUntrusted`, action `review-project-policy` → Settings › Project targets) asks for review. `project.policy.accept { projectId }` records the hash, applies the file's rules and target policies, clears the banner and appends an audit `policy-changed` row whose `detail` carries the diff against the previously accepted summary (`rules.added/removed/changed`, `targets[{target, from, to}]`). `project.policy.accept` takes the `hash` the banner carried (`action.hash`), so a file rewritten between review and click is refused (`invalid-input`) and re-bannered with the new hash. A file with no policy or target config content is never gated; an untrusted file also never re-points a *connected* target through `targets[].config`. Hunks touching `.styx/project.json` are skipped by `hunk.acceptAll` and never auto-approved by an `autoApproveEdits` session.

TODO (Settings owner): render `project.policy.pending { projectId }` → `diff` (rules added/removed/changed, target policy from → to, `configChanged`) next to the "Accept project policies" button so the user sees what they are trusting; today the row shows only the banner sentence. Consider requiring MFA on accept when the file grants `always` or an `auto-approve` rule matching `env: prod`.

---

## 5. Main-process architecture

Services are classes built once in `container.ts` with explicit deps; they emit typed events on an `EventBus`; `ReadModel` subscribes and publishes deltas. Git/CLIs via `execa`.

| Service                                              | Responsibilities                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **ProjectService**                                   | scan (`~/code ~/work ~/dev ~/src`, `C:\dev`, depth 3, plus IDE recents — git or not: a plain folder is listed `hasGit: false`, dated by when the IDE last opened it), add (**any readable directory**: a folder without `.git` gets a repo row with `default_branch NULL` and one main worktree at the folder itself with `branch NULL`; only `not-a-directory` is refused), gitInit (`git init -b main` + empty first commit, then repo row / main worktree reconciled onto `main`), clone, create (Empty: git init + README; Template: `resources/templates/*` or `gh repo list <org> --topic styx-template`; Agent-scaffold: spawn session on `main` with brief + instruction to call `ask_user(kind:'plan')` before first commit), remove, reorder, project-file reconcile, GitHub repo creation via GitHub target.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **GitService / WorktreeService**                     | system git ≥2.31; `git worktree add -b agent/<name>-<n> <path> <base>` (`<n>` next free per prefix); location `sibling` = `<repoParent>/.styx/worktrees/<repo>/<slug>`; status porcelain v2, numstat, diff `-U3`, conflict detection via `git merge-tree --write-tree` (git ≥2.38) after fetch; ahead/behind; PR state via `gh pr view --json` or REST with GitHub target token; Windows `core.longpaths`, autocrlf from `lineEndings`.                                                                                                                                                                                                                                                                                                                                                                                                    |
| **SessionService**                                   | node-pty spawn (`$SHELL -il` / `pwsh` / `wsl.exe`), env injection (§6), per-agent **AgentAdapter** builds argv + MCP/hook config; runners `pty` / `stream`; state from pty output (`activity`), 3 s silence (`quiet` → idle), Claude Code hooks (`Stop`, `Notification: agent_needs_input                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | permission_prompt                                                                              | idle_prompt`, `SessionEnd`, `PostToolUse Edit | Write`→ hunk rescan), Codex`notify`, regex heuristics for gemini/cursor pty; `finish`on exit;`error` on ENOENT (`cli-missing`), conflict, expired target. pty logs to `userData/logs/pty/<id>.log` with rotation. |
| **Broker** (`main/broker/server.ts`)                 | `net.createServer` on `STYX_BROKER`; NDJSON JSON-RPC 2.0; `hello` auth; holds long-lived `request_access` responses; push notifications (`grant.revoked`, `session.stopping`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **GrantService**                                     | request → `PolicyEngine.evaluate` → auto-issue or ask; approve (MFA gate re-evaluated in main), deny, revoke; one `setTimeout` per active grant for `expires_at`/`idle_expires_at` (re-armed on use) + 60 s sweep after sleep; session-end revocation; `once` revoked after first use; every transition → AuditService. (`cred_nonce` column is unused: revoke drops the in-memory bundle and every broker call re-checks the row state.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **PolicyEngine** (pure, `packages/core/src/policy/`) | rules top-to-bottom: persistent grant → target policy `always` → app rules by `ord` → project `policies.extra` → default ask. `requireMfa` forced when prod ∧ write/deploy/delete (not disableable). Rule kinds: `auto-approve{match,scopes,duration}`, `ask{match,scopes,requireMfa}`, `idle-expiry{match,idleMs}`. Defaults: #1 auto-read staging/preview 1h; #2 ask+MFA prod write; #3 idle 1h.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **CredentialVault**                                  | `@napi-rs/keyring` `Entry('dev.styx', credentialRef)`; `credentialRef = styx:v1:<provider>:<targetId>:<kind>`; JSON values; Windows 2560-byte cap → chunking; `MemoryVault` for tests/dev.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **ProviderAdapters**                                 | interface `connect / test / issue(grant) / revoke / health / scopeOfCommand(argv)` plus `cliStatus / cliLoginCommand` for the CLI-first path. **Primary auth is the provider's own CLI** (`authMethod: 'cli'`): `target.connect.cliStatus` reports what `gcloud` / `aws` / `gh` / `vercel` / `supabase` already know (installed, version, signed-in accounts — identities only), `target.connect.cliLogin` runs the CLI's login flow (`gcloud auth login`, `aws sso login --profile <p>` / `aws configure sso`, `gh auth login --web`, `vercel login`, `supabase login`) in a `term:` pty the renderer attaches to over the `pty` channel (`connect.cliLogin` running/exited), `target.connect.cliSave` stores a vault entry `{ kind:'cli', account, profile?, project? }` with **no secret** — the CLI owns the credential and mints on every grant. A shared `CliRunner` (execa on `PtyService.resolveLoginPath`, 20 s timeout, stdin ignored, output never logged) backs all five. GCP cli: `gcloud auth print-access-token --account <acct>` (+ `CLOUDSDK_CORE_PROJECT`); read-only grants are down-scoped via the STS token exchange with a Credential Access Boundary when `config.buckets` lists the Storage buckets (CABs only cover Storage), else `scoped:false`; revoke never calls Google (it would sign the user out of gcloud). AWS cli: `aws configure export-credentials --profile <p> --format process`; with `config.roleArn` the exported creds are narrowed by `sts:AssumeRole` + session policy (`scoped:true`, role chaining), else handed over as-is (`scoped:false` → MFA on prod for every scope); an expired SSO session → health `expired`, Reconnect reruns `aws sso login --profile <p>`. GitHub cli: `gh auth token --hostname github.com --user <login>` on every use (`--user` falls back for pre-2.40 gh). Vercel cli: the token in the CLI's own store (`~/Library/Application Support/com.vercel.cli/auth.json`, `%APPDATA%\vercel\auth.json`), read-only. Supabase cli: `~/.supabase/access-token`, else the CLI's keyring entry read via `@napi-rs/keyring`. **Advanced** keeps the previous modes: Vercel/Supabase token paste, GitHub device flow / PAT, AWS long-lived key → `sts:AssumeRole` with session policy (or `GetFederationToken`), scope→policy map, env `AWS_*`, scoped:true; GCP SA key → JWT (`jose`) → 1 h access token with `cloud-platform.read-only` for read-only grants. SSH: in-process ssh-agent (`ssh2` AgentProtocol) on a per-grant socket/pipe, each sign = `grant_uses` row; never the key file. `issuesScoped(scope, target)` answers per mode so unscoped prod grants force MFA. Trade-off of cli mode: the credential stays in the user's CLI store, reachable by any process running as the user (agent sessions included); Styx governs what it delivers per grant, not the CLI's own store — isolating agent sessions from the user's CLI config dirs is a follow-up. Health probes classify failures with `isAuthFailure` (reauth / SSO expired / logged out / 401-403 / publickey refused) — everything else is transient. "Scoped token, else env" recorded in audit `detail_json.scoped`. |
| **RefreshScheduler**                                 | Connections stay active without babysitting: every 30 min, on app focus (`browser-window-focus`) and on wake (`powerMonitor` `resume`) every connected target's `health()` runs (`TargetService.checkHealth`; focus/wake skip targets probed < 5 min ago, `target.refresh` never skips). Only a real mint failure (`CliAuthError.expired`: reauth needed, SSO session over, CLI logged out, token rejected) flips `health='expired'` and raises the auth-expired banner whose Reconnect runs the CLI login again; transient failures (CLI missing, timeout, network) leave health alone; success clears the banner. Audit `tested` rows only on transitions. A mint failure at grant-issue time (`GrantService.onIssueFailure`) expires the target immediately. Injected clock + timer primitives. |
| **MfaService**                                       | macOS `systemPreferences.promptTouchID(reason)`; Windows `UserConsentVerifier.RequestVerificationAsync` via `packages/native-winhello` (napi-rs), fallback PowerShell WinRT script, last resort app passphrase (argon2 hash in vault). Result never cached.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **AuditService**                                     | `append` computes `seq`, `prev_hash`, `hash` in one transaction; `list(cursor, filters)`; `exportJson`; `verifyChain`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **DetectService**                                    | IDEs (mac `/Applications`, `~/Applications`, JetBrains Toolbox, `which nvim`; win `%LOCALAPPDATA%\Programs\…`, Toolbox, PATH); versions from Info.plist/product.json/exe; imports: VS Code/Cursor recents from `state.vscdb` (`history.recentlyOpenedPathsList`, global + `profiles/*`; absent on VS Code 1.10x+) ∪ `User/workspaceStorage/<hash>/workspace.json` (dir mtime = last opened) ∪ `Backups/workspaces.json`, newest first; `keybindings.json`, theme/font from `settings.json`; JetBrains `recentProjects.xml`; Neovim shada (msgpack). CLIs on login-shell PATH with `--version`, auth from `~/.claude/.credentials.json`/keychain, `$CODEX_HOME/auth.json`, `~/.gemini/oauth_creds.json`, `cursor-agent status`; capabilities via `--help`. "Open in": `code`/`cursor`/`open -a WebStorm`/nvim tab. "Install Open in Styx": `styx://open?path=` protocol + PATH symlink / HKCU shell entry.                                                                                                                                           |
| **HunkService**                                      | attribution = worktree ownership. Record `base_commit` at spawn; chokidar (ignored from `git ls-files --ignored`), 300 ms debounce → `git diff -U3 <base> -- <files>` (+ `--no-index` for untracked) → `parse-diff` → upsert `agent_changes` by `hunk_hash` (vanished → `stale`). User Monaco writes tracked in a short-lived set to skip attribution. Accept = `git apply --cached --unidiff-zero <patch>`; Reject = `git apply -R <patch>` (+ system message to agent in stream mode); Done = accepted stay staged, pending stay unstaged.                                                                                                                                                                                                                                                                                               |
| **NotificationService**                              | `dnd` in ui_state; mac `app.dock.setBadge`, `bounce('informational')` once per first open ask, dock menu with recent asks + DND; win `Tray` with accent-dot icon, `Notification({toastXml})` with `styx://ask/<id>/review                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | later`protocol buttons,`setAppUserModelId`; persistent banners via `notifications.banner_key`. |
| **WindowService**                                    | main window frameless (`hiddenInset` + `trafficLightPosition {x:12,y:13}` on mac; `hidden` + `titleBarOverlay {height:38}` on win for Snap Layouts), min 1100×680; pop-outs `popout:<sessionId>` 400×500 restored from `window_state` and clamped to a live display; closing main closes pop-outs; sender allowlist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

---

## 6. Broker protocol, MCP server, CLI shims

**Endpoint**: mac `/tmp/styx-<uid>/broker.sock` (dir 0700, socket 0600); win `\\.\pipe\styx-<user>-<hash>`. **Session env** on every pty: `STYX_SESSION_ID`, `STYX_BROKER`, `STYX_TOKEN` (32 random bytes; sha256 stored in `sessions.broker_token_hash`), `STYX_PROJECT_ID`, `STYX_WORKTREE`, `STYX_CLI`, `STYX_EXE`, `PATH=<userData>/bin:<login PATH>`, `MCP_TIMEOUT=60000`. `<userData>/bin/` holds `styx` + shims that exec `ELECTRON_RUN_AS_NODE=1 "$STYX_EXE" "$STYX_CLI" wrap <name> "$@"`.

**Methods** (`packages/broker/src/protocol.ts`, zod): `hello{sessionId, token, client, pid}` · `request_access{target, scope[], reason, triggeredBy?, waitMs}` → `active{grantId, scope, expiresAt, decidedBy} | denied | pending{queuePosition}` · `check_grant` · `get_credential{grantId}` → `{kind: env|ssh-agent, env?, socketPath?, expiresAt}` · `exec_authorize{tool, argv, cwd}` → `{grantId, useId, env}` · `exec_report{useId, exitCode}` · `ask_user{kind: plan|decision|question, payload, waitMs}` · `report_status{note, state?}` · `hook{agent, event, payload}` · `list_targets`. Notifications: `grant.revoked`, `session.stopping`.

**Flow**: `request_access` → resolve target within the session's project → check `may_request_targets` → insert `grants(requested)` → `PolicyEngine`. Auto → issue, audit `granted` with `triggered_by='mcp:request_access'` + `policy_id` (rendered "auto: policy #n"), return `active`. Ask → `pending_asks` row, transcript `access-request` message, session → `needs-you`, `ask.opened` event (sheet, board, inbox, toast, badge all read the same row); the JSON-RPC response is **held** (push) until the user decides anywhere. `grant.approve` IPC → main recomputes `requireMfa` → `MfaService.verify` → `adapter.issue` → `active` with `expires_at`/`idle_expires_at` → audit `granted` (`triggered_by='grant sheet'`) → transcript `system` line `grant: supabase-prod · read+write · expires in 59m` → session leaves `needs-you` if queue empty. Deny → `denied`, session → `working`, no Styx copy.

**Shims**: `supabase db push` → shim calls `exec_authorize` → `scopeOfCommand(argv)` → find active covering grant or inline `request_access` with `reason="$ supabase db push"` (the audit "Triggered by") → `grant_uses` + audit `used` → shim `execvp`s the real binary with merged env → `exec_report`. `once` grants revoked after report. Rate limit 5 `request_access`/min/session. Reasons rendered as plain text.

**MCP server** (`styx mcp`, `@modelcontextprotocol/sdk` stdio): tools `request_access`, `check_grant`, `get_credential`, `list_targets`, `ask_user`, `report_status`. Per-CLI wiring (verify flags in Phase 8 spike): Claude Code `--mcp-config <tmp>/styx-mcp.json --settings <tmp>/styx-settings.json` (hooks → `styx hook claude`, `--append-system-prompt`, optional `--permission-prompt-tool mcp__styx__ask_user` in stream mode); Codex `-c 'mcp_servers.styx.command=…' -c 'notify=[…]'` (fallback per-session `CODEX_HOME`); Gemini `<worktree>/.gemini/settings.json` + `.git/info/exclude`; cursor-agent `<worktree>/.cursor/mcp.json`; shell = shims + `styx request/status/targets`.

**Threat model**: agents are the user's own processes; Styx controls credentials, not the sandbox. Token binds a connection to one session (one `hello` per connection); after revoke the row state is re-checked on every `get_credential`/`exec_authorize` and the in-memory bundle is gone (provider-side `revoke` is a no-op for GitHub/Vercel/Supabase — delivery stops, the upstream token lives on); persistent grants are only visible from the target's project; `requireMfa` never trusted from renderer, and prod ∧ unscoped adapter forces it even for read/auto; audit append-only + hash chain; renderer `sandbox:true`, `contextIsolation`, preload exposes only `window.styx = {command, subscribe, platform}`, `ipcMain.handle('styx:cmd')` validates sender frame + window registry + command name + zod input; CSP `default-src 'self'`; `fs.*` commands confined to the worktree path; `shell.openExternal` only for allowlisted https hosts.

---

## 7. IPC contract (`packages/core/src/ipc/contract.ts`)

Hand-rolled `invoke` + `webContents.send` with zod maps (electron-trpc rejected: need sender validation, multi-window fan-out, separate pty channel).

- **Commands** (~55): `project.{scan,add,clone,create,remove,reorder,select,settings.set,settings.reset}` · `session.{spawn,sendMessage,ptyInput,ptyResize,stop,archive,resume}` · `ask.respond` · `grant.{approve,deny,revoke}` · `target.{connect.start,connect.saveKey,connect.saveSsh,test,setPolicy,remove,reconnect}` · `policy.{upsert,toggle,reorder,remove,export}` · `worktree.{create,archive,fetch,diff,openInIde}` · `hunk.{accept,reject,acceptAll,rejectAll,done}` · `fs.{readFile,writeFile,listDir}` · `terminal.{spawn,input,resize,kill}` · `audit.{list,export,verifyChain}` · `settings.{get,set}` · `detect.{ides,clis}` · `ide.{import,installOpenIn,setFallback}` · `window.{popout,dock,control}` · `notify.{setDnd,later}` · `onboarding.complete` · `store.snapshot`. Every command returns `{ok:true} | {ok:false, error:{code,message}}`.
- **Events**: `store.delta{seq, deltas[]}` (batched per 16 ms tick; renderer resyncs via `store.snapshot` on a seq gap) · `pty.data{id, data}` (separate channel, ≤16 ms batches, flow-control ack) · `pty.exit` · `ask.opened` · `grant.result` · `connect.progress{flowId, phase}` · `banner.set/clear` · `hunks.changed` · `theme.resolved`.
- **Delta ops**: `upsert{table, rows}` · `remove{table, ids}` · `transcript.append` · `transcript.patch` (streaming text ≤30 Hz) · `hunks.replace` · `discovery.set` · `settings.set` · `popouts.set`.

---

## 8. Renderer architecture

**Structure**: screen-sliced with `features/` for widgets used on more than one screen/window (chat pane, grant sheet, audit drawer, palette, editor, terminal, modals, toast, titlebar, banners). Rule: `screens/*` → `features/*` → `@styx/ui`; nothing imports from `screens/`.

**Stores**: `state/readModel.ts` (zustand + immer; normalized `Table<T> = {byId, ids}` for projects, sessions, worktrees, targets, grants, auditEntries, policies; `transcripts[sessionId]`, `hunks[sessionId]`, `discovery`, `settings`, `popouts`, `seq`) and `state/uiStore.ts` (screen, projectId, projectSession map, overlays stack, resolvedTheme, platform, paneSizes, palette query/scope/activeId, diffFocusIndex, approvalsTab, settingsSection, onboardingStep, editorFile). `screen/projectId/projectSession/paneSizes` persist via `ui.persist` command. Pop-out windows load `index.html?popout=<sessionId>` and run the same `connectSync`.

**Selectors in `packages/core/src/selectors/`** (pure, `now` injected): `needsYouCount`, `workingCount` (excludes idle), `lockedCount`, `activeGrants`, `boardColumns` (needs-you | working+idle | done; zero-padded counts; empty copy), `sessionTabs` (3 visible + overflow; active replaces slot 3), `chatMeta`, `targetDerivedState`, `formatCountdown`, `formatAge`, `paletteResults` (fuzzy on label+meta, groups Actions/Agents/Projects, first row preselected, lock state in meta, `⇥` scope).

**Tokens** (`packages/tokens`): `tokens.json` verbatim (+ `terminalAnsi` block); build emits `css/tokens.css` (the handoff CSS inside `@layer tokens`, plus `--motion-sheet:160ms --motion-modal:120ms --motion-toast:160ms --ease-sheet`), `css/motion.css` (reduced-motion → opacity-only keyframes), `css/fonts.css` (Archivo 400–700, JetBrains Mono 400/500 woff2, `font-display:block`, subset incl. `U+2190-21FF, U+2500-25FF`), `src/generated.ts` (colors per theme for Monaco/xterm, sizes, motion, shortcuts). Theme: preference in `settings.theme`; main sets `nativeTheme.themeSource` and pushes `theme.resolved`; renderer sets `document.documentElement.dataset.theme`, `monaco.editor.setTheme`, xterm `options.theme`, win `setTitleBarOverlay`. Mod+Shift+T cycles dark→light→system.

**CSS layers** (`packages/ui/src/styles/`): `@layer reset, tokens, base, components, state, screens;` — `state.css`: `[data-inv="true"]{background:var(--tx);color:var(--bg)}` `[data-on="true"]{background:var(--ac);color:var(--acx);border-color:var(--ac)}`; components set the attribute only when true. `base`: box-sizing, `border-radius:0` on form controls, `:focus-visible{outline:1px solid var(--ac);outline-offset:1px}`, `::selection`. `type.css`: `.t-label .t-label-strong .t-mono .t-meta .t-body`.

**Component inventory** (`packages/ui`, each `X.tsx + X.module.css + X.stories.tsx + X.test.tsx`; all accept `inv?`, `on?`): Button (secondary/primary/accent[Grant only]/ghost/dashed × compact `5px 10px` / regular `6px 12px` / hunk `4px 10px` / footer `14px, min-height 44`; label type 600 10px .1em uppercase; hover `--s2` instant; disabled opacity .5; `::after` inset for 28px hit), Tab (34px, 7px dot, accent `!` badge, `▾` overflow), NavItem (`8px 14px`, meta), RailTile (36px, accent corner 8px, dashed add), Table (grid columns per screen; rows `14px 20px`), Card, Message (user/agent/file-list/decision/access-request/system; max-width 88–92%), Tag (9px 700 .1em, `1px 5px`), Checkbox (14/16 square, whole row hit target), ChipGroup (collapsing `-1px` borders; duration 4-up grid, env inline; radiogroup), Select (native, `min-width:140`, 170 in Targets), Input/Textarea (`--bg` fill, focus `--tx` border, masked), StatusDot (8/7 square; accent/text/line/hollow), Numeral (M 28 / L 56, tabular, zero-padded), Banner, Sheet/Drawer (360/380, `--bg`, `border-left:1px solid var(--tx)`, footer row), Modal (560/600, top 90, `--dim` backdrop, focus trap, Esc + backdrop close), Toast (340, right 16 top 52, 8 s), PaletteList (640, top 110, combobox + listbox + `aria-activedescendant`), Label, LabelValueRow (reset affordance), CounterTile, Titlebar (38px, `-webkit-app-region:drag`, mac padding-left 70 / win padding-right 138), EmptyState, Icon (inline SVG for `▾ ✕ ⤢ ─ ☐`). Exact recipes come from the prototype's inline styles (`/port-screen` and `/ui-component` skills extract them).

**Overlays** (`overlays/stack.ts`): kinds palette(z40, trap, dim) · modal(z30, trap, dim; max one) · toast(z20) · sheet/drawer(z10, trap, inside content region). `pushOverlay` records the invoker (`WeakRef`); `popOverlay` restores focus (or `editor.focus()` when invoker was Monaco); `inert` on `#layer-app` while trapping; Esc pops only the top. Mount-only animations with token durations; reduced-motion swaps keyframes.

**Keyboard** (`keys/registry.ts`, single capture-phase `keydown`): scopes `overlay > palette > composer|editor|terminal > diff|workspace|chat > global`; `RESERVED = Mod+K, Mod+P, Mod+1–4, Mod+Shift+O, Mod+Shift+N, Mod+Shift+T` pass through Monaco/xterm (xterm `attachCustomKeyEventHandler`); plain keys `a r j k`, Enter, Mod+Enter/Backspace go to editor/terminal when focused. `formatChord(chord, platform)` renders `⌘⇧O` / `Ctrl+Shift+O`; Ctrl+Alt chords rejected by test. Imported IDE keybindings → Monaco `addKeybindingRules` only, minus RESERVED.

**Tricky pieces**: Monaco mounted once per worktree, models cached per path, monochrome theme from tokens, options `fontSize 12.5, lineHeight 22, lineNumbersMinChars 3, minimap off, renderLineHighlight none`; hunks via `createDecorationsCollection` (`isWholeLine` + `.styx-hunk-line{background:var(--add)}`, first line `after:{content:'CLAUDE · 2M'}` pinned right; fallback `IContentWidget`); HunkBar renders only with pending hunks. xterm one `Terminal` per session kept alive across tab switches, fit in rAF, guard `clientHeight>0`, WebGL with context-loss fallback, 6px drag handle, collapse. Transcript: no virtualization v1 (last 500 + "Load earlier", `content-visibility:auto`, pin-to-bottom in a ref). Diff review and Repo lane diff use a custom `DiffBlock` (not Monaco diff editor); lane diff virtualized (`@tanstack/react-virtual`, 22px rows). Grant sheet closes eagerly, re-opens with inline error on MFA/issue failure. Pop-out = second BrowserWindow, same renderer, `ChatPane compact`; main window shows "Popped out" + Dock.

**Accessibility**: focus ring global; traps + return; palette combobox/listbox semantics; `aria-live=polite` on needs-you counters, toast host, and a hidden `#announcer` ("Granted Codex read, write on Supabase prod for 1 hour"); Monaco `accessibilitySupport:'on'` + xterm `screenReaderMode` from a setting; uppercase via CSS; hit targets ≥28, footers 44; icon-only buttons labelled; clickable rows `role=row tabIndex=0`.

---

## 9. Claude Code scaffolding

### 9.1 Root `CLAUDE.md` (write this content in Phase 1)

```markdown
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
- Why -> `UX Research Memo.dc.html`. `Wireframes.dc.html`, `support.js`, `doc-page.js` are history/viewer runtime: never port.
  Use `/spec-lookup <topic>` to read the HTML with tags stripped. Copy §10 strings verbatim from `packages/core/src/copy.ts`.
  Decisions with rationale: `docs/adr/`. Progress: `.planning/STATE.md` (owned by /gsd:*).

## Monorepo map (pnpm workspaces)

- `apps/desktop` — Electron: `src/main` (source of truth: SQLite, git, pty, keychain, broker), `src/preload` (typed bridge), `src/renderer` (React 19)
- `packages/core` — domain types, zod schemas, session/grant machines, policy engine, selectors, IPC contract. No Electron, DOM, I/O.
- `packages/ui` — component library + Storybook. Plain CSS Modules, tokens only.
- `packages/tokens` — tokens css/json re-exported, fonts bundled. `packages/broker` — broker protocol + `styx mcp`. `packages/cli` — `styx` CLI + provider shims.

## Commands

- `pnpm dev` (STYX_FIXTURE=demo seeds a temp DB) · `pnpm build` · `pnpm package:mac` / `package:win` · `pnpm rebuild:native`
- `pnpm test` · `pnpm test -F @styx/core` · `pnpm e2e` · `pnpm visual` (screenshots vs prototype) · `pnpm visual:baseline`
- `pnpm typecheck` · `pnpm lint` · `pnpm format` · `pnpm storybook` · `pnpm storybook:test`
- `pnpm db:generate` / `db:migrate` / `db:seed`

## Architecture rules

- Main process is the source of truth. Renderer holds a read-only mirrored Zustand store fed by snapshot + sequenced deltas.
- Renderer never touches fs, git, child processes, network, or secrets. Not even in dev.
- Every mutation is a named command: zod schema in `packages/core/src/ipc/contract.ts`, handler in `apps/desktop/src/main/ipc/commands/`, exposed as `window.styx.command(name, input)`. No ad-hoc IPC strings.
- Session and Grant state machines live in `packages/core/src/machines`; transitions are exhaustive tables, effects are data, time is injected (`ctx.now`).
- Policy evaluation is pure (`packages/core/src/policy`); main applies the result and logs it.
- IDs are ULIDs; timestamps are epoch ms numbers everywhere. Never join by names.
- `.styx/project.json` is versioned and zod-validated; secrets are never written there.

## Design fidelity (hard requirement)

- Use `--bg --s1 --s2 --ln --tx --mu --ac --acx --act --add --term --termtx --dim` and size/space vars. No raw hex, no px that exists as a token.
- `border-radius: 0`, no `box-shadow`, no gradients. Floating surfaces get `1px solid var(--tx)`.
- Selection vocab: `data-inv="true"` = current/inverted; `data-on="true"` = accent/armed. No `.active` classes.
- Hover is instant. Sheet 160ms slide, modal 120ms fade, toast 160ms slide; reduced-motion → fades only.
- Archivo (UI) + JetBrains Mono (code), bundled. Uppercase via `text-transform`. Square dots/checkboxes. Tabular numerals, zero-padded only in counters.
- Sizes from tokens.json (titlebar 38, rail 56, nav 168, files 200, chat 360, sheet 360, drawer 380 …). Window min 1100×680, no breakpoints.
- Verify every ported screen with `/visual-diff <screen>` before calling it done.

## Security invariants

- Secrets only in the OS keychain (`@napi-rs/keyring`) behind `credentialRef`. Never in SQLite, logs, IPC payloads, renderer state, fixtures, or the repo.
- `audit_entries` is append-only (triggers + hash chain). Revoke inserts a new row.
- Prod write/deploy/delete requires OS biometric before issuance; `requireMfa` is computed in main, never trusted from the renderer.
- Agents get scoped short-lived tokens or env for the grant lifetime only; SSH gets a forwarded agent socket, never a key file.
- Every request/grant/use/revoke/deny is audited with actor, session, worktree, and triggering command.

## Coding conventions

- TS strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. Named exports only (config files excepted).
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
- Don't `git push`, `git reset --hard`, `rm -rf`, or hand-edit `.planning/` state or `design/handoff/`.
- Don't skip the story, the test, or the visual diff.
```

### 9.2 Per-package `CLAUDE.md` (short; write in Phase 1)

- **apps/desktop**: three isolated trees; one handler per command under `src/main/ipc/commands/`; services are classes with injected deps; `src/main/store/` publishes deltas to every window; preload exposes exactly `window.styx`; renderer imports only `@styx/ui|core|tokens`; `STYX_FIXTURE`, `STYX_SCREEN`, `STYX_NOW`, `STYX_KEYCHAIN=memory` dev switches; e2e + visual baselines under `e2e/`.
- **packages/core**: pure TS, no mocks needed; `model/ schemas machines/ policy/ selectors/ ipc/ copy.ts keys/`; machine change without tests for every new transition is incomplete; time injected.
- **packages/ui**: one dir per component; variants from spec §8 exactly; tokens only; `check-design-css` hook rejects violations; focus ring, 28px hit, axe clean; no app state or IPC.
- **packages/broker**: zod-validated versioned protocol; never holds secrets; every request carries sessionId + worktreeId + command; queue rule; timers live in main.

### 9.3 `.claude/rules/` (path-scoped)

`css-tokens.md` (`paths: ["**/*.css","**/*.tsx"]`, full token table + forbidden properties), `ipc.md` (`apps/desktop/src/{main,preload}/**`), `security.md` (`packages/broker/**`, `packages/cli/**`, `apps/desktop/src/main/{providers,broker,services/credential-vault*}/**`), `testing.md` (`**/*.test.ts*`, `**/e2e/**`).

### 9.4 Skills (`.claude/skills/<name>/SKILL.md`)

| Skill                                        | Trigger / purpose                     | allowed-tools                                          | Core steps                                                                                                                                                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `spec-lookup`                                | "what does the spec say about X"      | Read, Grep, Bash(sed/grep/awk/head)                    | strip tags from the spec (`sed 's/<[^>]*>//g'`), print section index, slice a §; locate a prototype artboard by `data-screen-label`; quote verbatim with file:line.                                                                                                                        |
| `port-screen`                                | "port/implement the X screen"         | Read, Grep, Glob, Edit, Write, Bash(pnpm/sed/grep/awk) | locate artboard → inventory every element + inline recipe → map to `@styx/ui` (missing → `/ui-component` first) → add selectors with tests → implement `screens/<X>/` → register shortcuts → cover all strip states via fixtures → `/visual-diff` 4 variants → `design-fidelity-reviewer`. |
| `ui-component`                               | "add/extend component"                | Read, Grep, Glob, Edit, Write, Bash(pnpm)              | read §8 row → copy 2–3 prototype recipes → scaffold tsx/css/stories/test → `data-inv`/`data-on` props → matrix story → keyboard/focus test → `pnpm storybook:test`.                                                                                                                        |
| `ipc-command`                                | "add a command / wire button to main" | Read, Grep, Glob, Edit, Write, Bash(pnpm)              | contract entry → machine event if state changes → main handler (transaction, transition, effects, audit, delta) → renderer `useCommand` → schema + handler + CTA tests.                                                                                                                    |
| `state-machine-change`                       | "add a state / change grant expiry"   | Read, Grep, Edit, Write, Bash(pnpm)                    | quote §1 rule → update unions + transition table → effects as data → table-driven tests incl. invalid pairs + invariants (needs-you never times out, always never expires) → Mermaid in `docs/state-machines.md` → `state-machine-auditor`.                                                |
| `db-migration`                               | "add column / new table"              | Read, Edit, Write, Bash(pnpm, sqlite3)                 | edit schema → `db:generate` → hand-add CHECK/triggers → zod row schemas + mappers → fixtures/seed → migrate fresh + from previous version → secret-column name review.                                                                                                                     |
| `provider-adapter`                           | "add Vercel OAuth / AWS scoping"      | Read, Grep, Edit, Write, Bash(pnpm), WebFetch          | implement `ProviderAdapter` → keychain only via vault → scope matrix in header → wrapper shim → HTTP-mocked tests → `security-reviewer`.                                                                                                                                                   |
| `visual-diff`                                | "compare to prototype"                | Bash(pnpm), Read, Glob                                 | `pnpm visual -- --screen X` → read diff PNG → localize (font load, hairline, tracking, tabular-nums, `--w-*`) → baselines regenerate only when the handoff changes.                                                                                                                        |
| `run-app`                                    | "run/start app, won't start"          | Bash(pnpm/lsof/ps), Read                               | `STYX_FIXTURE=… STYX_SCREEN=… pnpm dev`; failure table (ABI mismatch → `rebuild:native`, stale socket, keychain loop → `STYX_KEYCHAIN=memory`, blank window → `--inspect`).                                                                                                                |
| `release` (`disable-model-invocation: true`) | "cut a release"                       | Bash(pnpm, git tag/log), Read                          | pre-flight full suite → bump → `package:mac` (hardened runtime, notarytool) → `package:win` (signtool) → smoke each artifact → changelog → tag.                                                                                                                                            |

### 9.5 Subagents (`.claude/agents/*.md`, all read-only: `disallowedTools: Write, Edit`)

`design-fidelity-reviewer` (yellow; tokens/radius/shadow/transition, `data-inv`/`data-on` vs classes, sizes vs tokens.json, typography, copy verbatim, motion, glyphs, platform chrome; reads diff PNGs; outputs severity table) · `security-reviewer` (red; leak greps for `token|secret|password|apiKey|privateKey` in logs/IPC/fixtures/schema/store; `contextIsolation/nodeIntegration/sandbox`; broker auth; MFA in main; audit triggers; timer cancellation; SSH agent) · `state-machine-auditor` (blue; §1 rules quoted inline; runs core coverage; reports untested (state,event) cells) · `a11y-reviewer` (green; §6 + §9 checklist; runs `storybook:test`) · `electron-native-debugger` (orange; ABI/asar/preload/notarization failure matrix; proposes exact command + permanent guard).

### 9.6 `.claude/settings.json` (committed)

- **allow**: `Bash(pnpm:*)`, `Bash(npx vitest|playwright|tsc|eslint|prettier|drizzle-kit:*)`, `Bash(node:*)`, `Bash(git status|diff|log|show|branch|worktree list|add|commit|stash:*)`, `Bash(gh pr|issue:*)`, `Bash(sed|grep|awk|head|tail|ls|find|sqlite3|lsof|ps:*)`, `WebFetch(domain:{www.electronjs.org, electron-vite.org, orm.drizzle.team, microsoft.github.io, xtermjs.org, playwright.dev, code.claude.com})`, `mcp__context7__*`, `mcp__playwright__*`, `mcp__sqlite__*`.
- **ask**: `git push|rebase|checkout|switch`, `pnpm package|publish`, `npx electron-builder`.
- **deny**: `rm -rf`, `git push --force|-f`, `git reset --hard`, `git clean`, `sudo`, `curl`, `wget`; `Read/Edit` of `.env*`, `*.pem|key|p12`, `~/.ssh/**`, `~/.aws/**`, `~/.config/gcloud/**`, `~/.netrc`; `Edit(./.planning/STATE.md)`, `Edit(./design/handoff/**)`, `Edit(./apps/desktop/e2e/visual/__baseline__/**)`. (Absolute-path form `Read(//Users/nic/.ssh/**)` matches the existing global settings; verify `~/` support.)
- **env**: `STYX_KEYCHAIN=memory`, `STYX_FIXTURE=demo`.
- **hooks** (scripts in `.claude/hooks/`, `jq` reads `tool_input`): PreToolUse `Bash` → `guard-git-secrets.sh` (blocks `git add/commit` with `.env|pem|key|p12|credentials.json` staged or credential-shaped strings `AKIA…|ghp_…|sk-…|BEGIN PRIVATE KEY|xox[bp]-`; exit 2); PreToolUse `Edit|Write|MultiEdit` → `guard-secret-paths.sh`; PostToolUse `Edit|Write|MultiEdit` → `post-edit-format.sh` (prettier + eslint --fix on the file), `check-design-css.sh` (in `packages/ui` and `src/renderer`: raw hex, `border-radius:[^0]`, `box-shadow` not none, gradients, non-transform/opacity transitions, literal `font-family`, `className=…active|selected` → exit 2 with guidance), `story-reminder.sh` (component without `.stories.tsx` → stdout reminder); Stop → `stop-typecheck.sh` (typecheck changed packages, print summary); SessionStart `startup|resume|clear` → `session-context.sh` (head of `.planning/STATE.md` + `git status --short`).

### 9.7 `.mcp.json` (dev tools, committed)

`context7` (`npx -y @upstash/context7-mcp`; gsd `plan-phase` pre-approves it) · `playwright` (`npx -y @playwright/mcp@latest --headless --viewport-size 1280,800`; drives Chromium for prototype/Storybook screenshots; the Electron app is driven by the repo's own Playwright harness) · `sqlite` (`uvx mcp-server-sqlite --db-path .dev/styx.db`; verify launcher, `sqlite3` CLI fallback). Omitted: GitHub MCP (`gh` suffices), pencil (no `.pen`), magic/21st, mongodb (disable in `enabledPlugins` for this project).

### 9.8 Memory strategy

Facts/rules → CLAUDE.md; file-type rules → `.claude/rules`; procedures → skills; decisions → `docs/adr`; progress → `.planning` (gsd-owned); personal → `CLAUDE.local.md` (gitignored: signing identity name, notarytool env var names).

---

## 10. Roadmap (`.planning/ROADMAP.md`, gsd format; `depth: comprehensive`, `parallelization: true`, `max_concurrent_agents: 3`, `gates.confirm_plan: true`)

`PROJECT.md` core value: _"An agent can never reach a deploy/server target without a scoped, expiring, audited grant the user approved, and the UI is the prototype, pixel for pixel."_ Out of scope: Linux, team policy sync, custom themes, >4 agent tabs, extensions/LSP, cross-repo sessions, WSL as requirement.

| Phase                           | Goal                                                                                                                                              | Plans                                                                                                                                                                                                                                                                                                                                                                                      | Exit criteria                                                                                                                           | Skills / Agents                                                                                | Spike first                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **1 Repo bootstrap**            | Clone → `pnpm dev` shows blank themed window with bundled fonts; Claude tooling complete                                                          | 01-01 workspace + TS/eslint/prettier/vitest + CI mac+win · 01-02 electron-vite skeleton, frameless window, `data-theme`, `rebuild:native` · 01-03 `packages/tokens` + `git mv design_handoff_styx design/handoff` + ADR-0001..0013 · 01-04 CLAUDE.md ×5, rules, 10 skills, 5 agents, hooks, settings, .mcp.json, `demo` fixture, `git init` + `/gsd:new-project`                           | CI green both OSes; hooks fire (write a hex color → blocked); `/spec-lookup 8` returns component table                                  | spec-lookup, run-app / electron-native-debugger                                                | —                                                                                                               |
| **2 Domain core**               | `@styx/core` encodes spec §1 fully, 100% branch-covered                                                                                           | 02-01 entities + zod + project-file v1 + ulid/time · 02-02 session machine + board selectors + retention · 02-03 grant machine (queue, MFA predicate, expiry/idle/session-end/revoke) + policy engine + audit builder · 02-04 selectors, IPC contract, copy.ts (§10), keys                                                                                                                 | coverage 100% machines/policy/selectors; auditor confirms every §1 rule; Mermaid matches                                                | state-machine-change / state-machine-auditor                                                   | —                                                                                                               |
| **3 Persistence + IPC**         | Migrated SQLite; every command reachable via typed IPC; renderer mirrors store                                                                    | 03-01 Drizzle schema + CHECK/triggers + migrations + seed · 03-02 command bus (transaction → transition → effects → audit → delta), preload `window.styx` · 03-03 renderer read model, `useCommand`, snapshot/delta/resync, multi-window fan-out · 03-04 contract test per command; `STYX_FIXTURE/STYX_SCREEN/STYX_NOW`; sqlite MCP on `.dev/styx.db`                                      | tests green with in-memory SQLite; security-reviewer: no secret column, preload surface = `styx` only                                   | db-migration, ipc-command / security-reviewer                                                  | —                                                                                                               |
| **4 Shell + component library** | Every §8 component with stories; shell matches prototype; visual harness in CI                                                                    | 04-01 visual harness (bake baselines from `Styx.dc.html` via strips at 1280×800 × theme × chrome, fonts routed to bundled woff2; Electron screenshot runner; pixelmatch ≤0.2%) · 04-02 primitives · 04-03 containers · 04-04 overlays + overlay/focus manager + motion · 04-05 Titlebar mac/win, Rail, Nav, banner stack, theme controller, keyboard registry · 04-06 axe + keyboard tests | matrix stories for all; shell visual diff passes 4 variants; zero `check-design-css` exemptions                                         | ui-component, visual-diff / design-fidelity-reviewer, a11y-reviewer                            | 04-01 before the rest                                                                                           |
| **5 Read-mostly screens**       | Home, Agents board, Approvals, Settings pixel-accurate over fixtures; CTAs dispatch commands                                                      | 05-01 Home · 05-02 Agents board · 05-03 Approvals (inbox, policies, audit drawer Copy JSON/Revoke) · 05-04 Settings (nav 220, targets table select 170, reset affordance) — wave-parallel                                                                                                                                                                                                  | visual diff per screen and state; approving in Approvals updates board/home counters via store                                          | port-screen, spec-lookup, visual-diff / design-fidelity-reviewer                               | —                                                                                                               |
| **6 Workspace**                 | Monaco, xterm, files pane, hunk bar, terminal, status bar, chat pane, grant sheet over fixture sessions                                           | 06-01 Monaco (theme, workers, tab row, files pane) + status bar · 06-02 xterm pane bound to fake pty stream · 06-03 chat pane (tabs, meta, 6 message kinds, composer) · 06-04 grant sheet → `grant.approve/deny`; hunk bar + decorations                                                                                                                                                   | visual diff default/sheet/hunk-bar states; Mod+1–4, Mod+⏎/⌫ work; sheet focus trap passes                                               | port-screen, ui-component, ipc-command / design-fidelity-reviewer, a11y-reviewer               | Monaco workers + xterm smoke in an empty window                                                                 |
| **7 Real sessions**             | Spawn real CLIs in own worktrees via node-pty; stream to xterm + transcript; state from real events                                               | 07-01 pty service, CLI detection + auth state, cli-missing → paused + banner · 07-02 git worktree service (create/list/changes/conflict) · 07-03 Spawn modal → worktree + CLI + Workspace · 07-04 transcript capture (stream + pty), idle/working, done, 7-day archive job                                                                                                                 | e2e: spawn shell, type, see output; missing `codex` shows §10 copy; worktree appears in Repo data                                       | ipc-command, state-machine-change, run-app / electron-native-debugger, state-machine-auditor   | `claude -p --input/output-format stream-json` under pty vs pipes; how each CLI signals "needs input" (ADR-0010) |
| **8 Grant broker**              | Agents request via broker; asks pause sessions; approvals anywhere resolve everywhere; policies, audit, expiry, MFA                               | 08-01 protocol + socket/pipe server + token auth + queue · 08-02 `styx mcp` + per-CLI config injection · 08-03 `styx` CLI + shims + env fallback · 08-04 GrantService: policy, MFA gate, vault, timers, revoke propagation, audit chain · 08-05 e2e: request → needs-you everywhere → grant → system line → audit → countdown → revoke from lock glyph                                     | security-reviewer clean; policy #1 auto-approves staging read logged "auto: policy #1"; prod write without MFA impossible from any path | ipc-command, state-machine-change, provider-adapter / security-reviewer, state-machine-auditor | Touch ID + Windows Hello from Electron main; Codex `-c mcp_servers…` and Gemini config-dir injection            |
| **9 Providers**                 | Connect modal works for real: OAuth (GitHub, Vercel, Supabase), keys (AWS, GCP), SSH; test connection; scoped tokens; expired → banner            | 09-01 Connect modal + vault · 09-02 GitHub device flow, Vercel token, Supabase PKCE · 09-03 AWS STS + GCP SA tokens + in-process ssh-agent · 09-04 health checks, auth-expired pause + Reconnect, wrapper shims                                                                                                                                                                            | mocked tests per adapter; human checkpoint on one real GitHub target; security-reviewer clean                                           | provider-adapter / security-reviewer                                                           | register Styx GitHub App / Supabase OAuth app early; Windows named-pipe `SSH_AUTH_SOCK`                         |
| **10 Repo + Diff review**       | Worktree lanes, Fetch, + Worktree, lane diff, conflict/Resolve; Diff review a/r/j/k, Done applies accepted hunks                                  | 10-01 hunk service (parse, apply/reverse, attribution) · 10-02 Repo screen + conflict state (session paused/resumed) · 10-03 Diff review + keyboard + Done; Workspace decorations on same data                                                                                                                                                                                             | visual diff both screens; e2e accept/reject on fixture repo; conflict pauses owning session                                             | port-screen, ipc-command / design-fidelity-reviewer, state-machine-auditor                     | — (can run parallel to 9)                                                                                       |
| **11 Onboarding + New project** | 4-step onboarding; New project (empty/template/agent scaffold, git init, GitHub repo, copy targets, open in IDE); IDE detect/import; Open in Styx | 11-01 IDE detection + imports + protocol handler · 11-02 machine scan + IDE recents → Projects step · 11-03 Onboarding screen (rail/nav hidden) · 11-04 New project modal + templates + agent-scaffold path                                                                                                                                                                                | fresh profile runs onboarding to Home; New project creates dir/repo/optional GitHub repo (mocked in CI)                                 | port-screen, ipc-command, provider-adapter / design-fidelity-reviewer                          | —                                                                                                               |
| **12 Notifications + windows**  | Toast, dock badge/bounce/menu + DND, tray + Action Center, pop-out chat, persistent banners                                                       | 12-01 toast + aria-live + Later; banner persistence · 12-02 dock/tray/Action Center · 12-03 pop-out window + Dock + Mod+Shift+O                                                                                                                                                                                                                                                            | e2e toast + pop-out; manual OS-notification checkpoint per platform                                                                     | port-screen, ipc-command / a11y-reviewer, electron-native-debugger                             | — (parallel to 11)                                                                                              |
| **13 Hardening + release**      | Ship v1 candidates for mac and win                                                                                                                | 13-01 a11y pass on every screen/overlay · 13-02 fidelity pass every screen × state × theme × chrome + copy audit · 13-03 e2e consolidation (spawn→grant→deploy→revoke; onboarding; new project), perf budget (cold start <2 s, screen switch <100 ms) · 13-04 electron-builder mac sign+notarize, win sign, `/release` validated                                                           | Definition of done met; artifacts install on clean machines                                                                             | visual-diff, release / all reviewers                                                           | —                                                                                                               |

Bootstrap sequence: `git init` → `/gsd:new-project` (paste PROJECT.md) → `/gsd:create-roadmap` and replace with the table above in gsd's phase format → `/gsd:plan-phase 1`.

---

## 11. Verification

- **Per phase**: exit criteria above; `pnpm typecheck && pnpm lint && pnpm test` green; the named reviewer subagent run on the phase's diff.
- **Fidelity**: `pnpm visual` compares Electron screenshots (1280×800, masked native chrome) against baselines baked from `Styx.dc.html` for every screen/overlay/state × {dark,light} × {mac,win}; `fidelity.spec.ts` asserts pane sizes (files 200, tab row 34, hunk bar 40, terminal 130, status 26, chat 360, sheet 360, drawer 380, nav 220, palette 640, modals 560/600, toast 340, popout 400×500).
- **Behavior**: Playwright Electron e2e on `STYX_FIXTURE=demo`: grant propagation (chat → board → inbox → audit → target → counters), spawn, diff j/k/a/r/Mod+⏎, palette fuzzy + Esc focus return, theme toggle, pop-out/dock, onboarding, new project.
- **Security**: `security-reviewer` on Phases 3, 8, 9, 13; `audit.verifyChain` in Settings; grep-based leak checks in hooks.
- **Definition of done (v1)**: all screens/modals/palette/toast/pop-out/banners pass visual diff; the end-to-end story (onboard → project → spawn → agent requests target → ask everywhere → approve with MFA / deny → scoped token → audit with command → revoke from lock glyph → review hunks → merge lane) works; security review clean; CI green on macOS + Windows; §6 keyboard map and §9 a11y complete; signed `.dmg` and `.exe` run onboarding on clean machines.

## 12. Top risks (mitigation = spike listed in §10)

1. Structured transcript vs pty TUI per CLI (ADR-0010 runner column keeps pty as universal fallback).
2. MCP injection for Codex/Gemini without touching global config (worktree-local config + `.git/info/exclude` fallback).
3. Windows Hello native route (napi-rs → PowerShell WinRT → app passphrase).
4. Windows SSH agent named pipe (fallback `ssh` shim with `-o IdentityAgent`).
5. Provider OAuth app registrations (PAT/paste paths exist for every provider).
6. Monaco workers in electron-vite; xterm fit/WebGL; frameless drag regions; focus trap vs Monaco (`inert` on app layer).
7. Native rebuild churn (pin Electron; CI smoke opens DB, spawns pty, reads/writes vault).

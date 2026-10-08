# Adding an agent CLI

An agent in Styx is a coding-agent command-line tool that Styx finds on your computer and runs for you: Claude
Code, Codex, Gemini CLI, Cursor agent, OpenCode, or a plain shell. Styx does not ship its own model. It starts the CLI you
already have and are signed in to, inside a git worktree of the project, with Styx's MCP server and command shims
wired in. When you add one, users can pick it in the Spawn agent modal and on the Tasks board. Its chat shows in
the workspace, its permission prompts become Allow / Deny cards, and every attempt it makes to reach a deploy target
goes through a scoped, expiring grant.

This guide follows the current code. Where the design docs and the code disagree, the code wins.

## How it fits together

Data flows through these parts in this order.

1. **The name.** `agentSchema` in [`packages/core/src/model/common.ts`](../../packages/core/src/model/common.ts) is
   the list of agent ids. Every IPC command, row schema and `.styx/project.json` field that names an agent derives
   from it. `AGENT_LABEL` in the same file is the short display name.
2. **Detection.** `DetectService` in
   [`apps/desktop/src/main/services/detect-service.ts`](../../apps/desktop/src/main/services/detect-service.ts)
   looks for the binary (login-shell `PATH`, vendor install folders, editor extension bundles, a manual "Locate
   binary" pick). It runs `--version`, reads `--help` into a `capabilities` map (`streamJson`, `printMode`,
   `appServer`, `acp`, …), and guesses sign-in state from the CLI's own files. The login shell is asked about every
   binary name in `SHELL_WHICH_NAMES` in
   [`apps/desktop/src/main/services/pty-service.ts`](../../apps/desktop/src/main/services/pty-service.ts). Results are
   stored as `CliInstall` rows and refreshed by the `detect.clis` command.
3. **Runner choice.** `runnerFor()` in
   [`apps/desktop/src/main/services/session-service.ts`](../../apps/desktop/src/main/services/session-service.ts)
   turns the agent and its capabilities into `'pty'` (the CLI's own TUI in an xterm terminal) or `'stream'` (Styx
   drives the CLI over pipes and renders a native chat).
4. **Launch.** `SessionService` builds an `AgentLaunchContext` (worktree path, first message, model, permission
   mode, the session env with `STYX_SESSION_ID`, `STYX_BROKER`, `STYX_TOKEN` and the shim directory first on `PATH`)
   and calls `buildAgentLaunch()` in [`apps/desktop/src/main/agents/index.ts`](../../apps/desktop/src/main/agents/index.ts).
   That switches to a per-agent function, such as `geminiLaunch()` in
   [`apps/desktop/src/main/agents/gemini.ts`](../../apps/desktop/src/main/agents/gemini.ts), which returns an
   `AgentLaunch`: command, args, extra env, how the first message is delivered, an optional `stream` kind, and a
   `cleanup()`. The types and shared helpers are in
   [`apps/desktop/src/main/agents/types.ts`](../../apps/desktop/src/main/agents/types.ts).
5. **The process.** A `pty` launch goes to `PtyService`. Styx sees the session as working while output flows and
   idle after `QUIET_MS` (3 s) of silence. A `stream` launch goes to the `RunnerMux` in
   [`apps/desktop/src/main/services/runner-mux.ts`](../../apps/desktop/src/main/services/runner-mux.ts), which picks a
   backend by `stream.kind`:
   - `stdin` / `argv`: `StreamRunner` in
     [`stream-runner.ts`](../../apps/desktop/src/main/services/stream-runner.ts) (Claude Code's stream-json, and
     Cursor's `--print --output-format stream-json` fallback).
   - `app-server`: `AppServerRunner` in
     [`app-server-runner.ts`](../../apps/desktop/src/main/services/app-server-runner.ts) (Codex only).
   - `acp`: `AcpRunner` in [`acp-runner.ts`](../../apps/desktop/src/main/services/acp-runner.ts), a generic Agent
     Client Protocol client (Gemini CLI, Cursor agent and OpenCode today).

   Each backend turns the CLI's events into `StreamEffect`s: transcript rows, tool steps, permission asks, usage,
   and the quiet signal that ends a turn. The backends are registered in
   [`apps/desktop/src/main/container.ts`](../../apps/desktop/src/main/container.ts).

6. **Talking back to Styx.** The agent reaches Styx through the `styx mcp` server (tools such as `request_access`,
   `ask_user`, `report_status`) and through the shims (`gh`, `vercel`, `aws`, `gcloud`, `supabase`, `ssh`) on its
   `PATH`. Both go over the broker protocol in [`packages/broker/src/protocol.ts`](../../packages/broker/src/protocol.ts)
   to the host in [`apps/desktop/src/main/broker/host.ts`](../../apps/desktop/src/main/broker/host.ts). How the MCP
   server reaches the CLI depends on the runner: ACP and app-server hand it over in the protocol; the other launches
   write it into a config file (`writeWorktreeMcpConfig()`, or a file under `configDir` for flags like Claude's
   `--mcp-config`). CLIs with lifecycle hooks can also call `styx hook <agent>`
   ([`packages/cli/src/hook.ts`](../../packages/cli/src/hook.ts)), which lands in `SessionService.onHook()`.
7. **Instructions.** CLIs without a system-prompt flag are listed in `PREAMBLE_AGENTS` in `agents/types.ts`. They get
   `agentPreamble()` (use the shims, peers exist, which lane you are on) as text ahead of their first turn.
8. **Setup and sign-in.** `AgentService` in
   [`apps/desktop/src/main/services/agent-service.ts`](../../apps/desktop/src/main/services/agent-service.ts) backs
   the Connect agent modal (status probe, CLI login, install guide). `AgentSetupService` in
   [`apps/desktop/src/main/services/agent-setup-service.ts`](../../apps/desktop/src/main/services/agent-setup-service.ts)
   backs the onboarding "Which AI do you use?" cards (install, sign in, one test message). Install commands are in
   [`packages/core/src/model/agent-install.ts`](../../packages/core/src/model/agent-install.ts).
9. **The renderer.** It never sees the process. It reads the mirrored store and lists agents from `SPAWN_AGENTS` in
   [`apps/desktop/src/renderer/features/modals/modals.ts`](../../apps/desktop/src/renderer/features/modals/modals.ts),
   names them through [`packages/core/src/copy.ts`](../../packages/core/src/copy.ts), and colours them with
   `AgentDot` from [`packages/ui/src/primitives/AgentDot/`](../../packages/ui/src/primitives/AgentDot/AgentDot.tsx).

Design background: [ADR-0010](../adr/0010-session-runners.md) (pty vs stream),
[ADR-0016](../adr/0016-codex-app-server.md) (Codex app-server), [ADR-0017](../adr/0017-acp-runner.md) (ACP), and
[`docs/research/agent-parity.md`](../research/agent-parity.md).

## Worked example: Gemini CLI

Gemini is the example because its launch adapter is the smallest real one (47 lines) and it shows both paths a new
CLI is likely to take: ACP over pipes when the CLI supports it, and the TUI in a terminal when it does not.

### 1. Detection

`DetectService` has one row per agent, with the binary names to look for:

```ts
const CLIS: { agent: AgentKind; label: string; bins: string[] }[] = [
  // …
  { agent: 'gemini', label: 'Gemini CLI', bins: ['gemini'] },
```

Once a binary is found, its `--help` is matched against a few patterns. The one that matters for Gemini:

```ts
      acp: /(^|\s)(--acp|acp)\b/.test(help),
```

Sign-in state is read from the CLI's own files, never from the secrets in them:

```ts
      case 'gemini':
        return exists(h, '.gemini', 'oauth_creds.json') || !!this.deps.env['GEMINI_API_KEY']
          ? 'signed-in'
          : 'signed-out';
```

`AGENT_MARKERS` in the same file (`gemini: /gemini/i`) stops a user from pointing "Locate binary" at the wrong CLI.

### 2. Runner choice

`runnerFor()` sends Gemini to the stream runner only when the CLI advertised ACP:

```ts
// Gemini and Cursor: the Agent Client Protocol; Cursor's print mode is the fallback (no approvals there).
if (agent === 'gemini' && caps['acp'] === true) return 'stream';
```

Everything else falls through to `'pty'`. The table test is
[`runner-for.test.ts`](../../apps/desktop/src/main/services/runner-for.test.ts).

### 3. The launch adapter

The ACP branch is short because the protocol carries everything else (the MCP server, the first message, mode
changes):

```ts
if (ctx.runner === 'stream' && ctx.capabilities['acp'] === true) {
  args.push('--acp');
  if (ctx.model) args.push('-m', ctx.model);
  return {
    command: ctx.binary,
    args,
    env: {},
    typeFirstMessage: false,
    stream: { kind: 'acp' },
    cleanup: async () => undefined,
  };
}
```

The pty fallback has to give the TUI the styx MCP server through a file. It merges an entry into the worktree's
`.gemini/settings.json`, keeps that file out of git with `.git/info/exclude`, and restores it on cleanup:

```ts
const written = await writeWorktreeMcpConfig(file, ctx, io, dir);
await excludeLocally(ctx.worktreePath, '.gemini/settings.json');
if (ctx.model) args.push('-m', ctx.model);
if (ctx.firstMessage) args.push('-i', ctx.firstMessage);
return { command: ctx.binary, args, env: {}, typeFirstMessage: false, cleanup: () => written.restore() };
```

`writeWorktreeMcpConfig()` uses `styxMcpServerInherit()`, which has no `env` block. That matters: `STYX_TOKEN` must
never be written into the worktree. The CLI starts `styx mcp` with its own session env, which already has the token.

`buildAgentLaunch()` in `agents/index.ts` has one `case` per agent that calls the adapter.

### 4. The ACP runner

Gemini needs no Gemini-specific runner. `AcpRunner` sends `initialize`, `session/new` (with the styx MCP server in
`mcpServers`), then `session/prompt` per turn. It answers `session/request_permission` with the user's Allow / Deny,
and turns `session/update` into transcript and tool rows. Two small per-agent tables live there:

- `GEMINI_MODES` maps Styx's permission modes onto Gemini's own mode ids (`auto_edit`, `yolo`, `plan`).
  `resolveAcpMode()` tries the Gemini table, then the Cursor table, then a match by name.
- `pickAuthMethod()` picks an ACP `authenticate` method that needs no browser (`gemini-api-key` when
  `GEMINI_API_KEY` is set).

The runner tests are in [`acp-runner.test.ts`](../../apps/desktop/src/main/services/acp-runner.test.ts).

### 5. Preamble, sign-in and setup

- `PREAMBLE_AGENTS` includes `'gemini'`, because Gemini has no flag for extra system-prompt text.
- `AgentService` has no status command for Gemini, so `probeGemini()` reads `~/.gemini/oauth_creds.json` and
  `google_accounts.json`. `LOGIN_ARGS.gemini` is `[]`: Gemini signs in on its first run.
- `RECIPES.gemini` in `agent-install.ts` installs it with Homebrew or npm. `AgentSetupService` downloads a private
  Node.js first when there is no npm (the `notInstalledGemini` copy says so).

### 6. Names, colour, copy

- `AGENT_LABEL.gemini = 'Gemini'` (core), and in `copy.ts`: `agents.gemini`, `agentProducts.gemini = 'Gemini CLI'`,
  `agentSetup.*.gemini`, `skills.hosts.gemini`, and `session.permissionModeHintsByAgent.gemini` (what each permission
  mode means for this CLI).
- The colour is the `agentGemini` token in `colorLane` (dark and light) in
  [`packages/tokens/tokens.json`](../../packages/tokens/tokens.json). The build script emits it as `--agent-gemini`,
  and [`AgentDot.module.css`](../../packages/ui/src/primitives/AgentDot/AgentDot.module.css) uses it for
  `data-agent='gemini'`.

### 7. Tests

- [`gemini.test.ts`](../../apps/desktop/src/main/agents/gemini.test.ts) checks both launches: the ACP args, and the
  pty fallback's settings file (with no token in it, removed on cleanup).
- The fake CLI [`e2e/fixtures/bin/gemini`](../../apps/desktop/e2e/fixtures/bin/gemini) answers `--version` and
  `--help` (which lists `--acp`) and speaks a scripted ACP session.
  [`acp-session.spec.ts`](../../apps/desktop/e2e/acp-session.spec.ts)
  re-detects so the fake wins, spawns a Gemini session, sees `pong`, allows a permission ask, and switches mode.

## Adding yours

Pick the transport first. In order of preference:

1. **ACP.** If the CLI speaks the Agent Client Protocol (check its `--help` for an `acp` subcommand or `--acp`
   flag), you reuse `AcpRunner` and get a native chat with approvals, mode switching and model lists for very
   little code. Your adapter looks like Gemini's ACP branch.
2. **Claude-style stream-json.** If the CLI prints Claude Code's `stream-json` events, reuse `StreamRunner` with
   `{ kind: 'stdin' }` or `{ kind: 'argv', resumeFlag }`, as Cursor's print fallback does.
3. **A new protocol.** Write a backend that implements `StreamRunnerLike` and emits the shared `effect` / `exit`
   events, add a `StreamInput` kind in `agents/types.ts`, and register it in `container.ts`. Look at
   `AppServerRunner` first. This is a large change; open an issue before you start.
4. **pty only.** Always works as a fallback. Users get the CLI's own TUI in a terminal, approvals happen inside the
   TUI, and background tasks (`session.purpose`, which need a stream runner) are refused with a note.

Then change these places. Below, `myagent` stands for your agent id. Lowercase, no spaces.

The compiler finds some of these for you: anything typed `Record<Agent, …>` or an exhaustive `switch` fails
`pnpm typecheck` until you add the new key. Plain lists, zod enums outside core, SQL and regexes do not. Work through
the whole list.

### Required: the agent exists and runs

1. **Core enum and label.** Add `'myagent'` to `agentSchema` and an entry to `AGENT_LABEL` in
   [`packages/core/src/model/common.ts`](../../packages/core/src/model/common.ts).
2. **Duplicated agent types.** These are separate lists of the same ids. Add yours to each:
   - `AgentKind` in [`detect-service.ts`](../../apps/desktop/src/main/services/detect-service.ts).
   - `HookAgent` in [`session-service.ts`](../../apps/desktop/src/main/services/session-service.ts).
   - `AgentKind` in [`packages/ui/src/primitives/AgentDot/AgentDot.tsx`](../../packages/ui/src/primitives/AgentDot/AgentDot.tsx).
   - `SessionBrief.agent` and `hook.params.agent` in
     [`packages/broker/src/protocol.ts`](../../packages/broker/src/protocol.ts). The broker client zod-checks the
     `hello` reply, so if you miss this one, `styx mcp` and every shim fail for your agent's sessions.
   - The list in `hook()` in [`packages/cli/src/hook.ts`](../../packages/cli/src/hook.ts).
3. **Database.** `sessions.agent` and `cli_installs.agent` have SQL `CHECK` constraints. Add the id to both
   `enum` lists in [`apps/desktop/src/main/db/schema.ts`](../../apps/desktop/src/main/db/schema.ts), then write a new
   migration in [`apps/desktop/src/main/db/migrations/`](../../apps/desktop/src/main/db/migrations/) that rebuilds
   both tables. SQLite cannot alter a `CHECK`. Follow
   [`0008_user_pause.sql`](../../apps/desktop/src/main/db/migrations/0008_user_pause.sql), but copy the current
   column list: later migrations added columns to `sessions`. See the `db-migration` skill in
   [`.claude/skills/db-migration/SKILL.md`](../../.claude/skills/db-migration/SKILL.md).
4. **Detection.** In [`detect-service.ts`](../../apps/desktop/src/main/services/detect-service.ts): a row in `CLIS`
   (label and every binary name), an entry in `AGENT_MARKERS` (a regex the CLI's `--version` output matches), and a
   `case` in `authState()` that checks the CLI's credential files or env var without reading secrets. If the CLI
   needs a capability flag the existing patterns do not cover, add it to the `capabilities` map. Add the binary
   names to `SHELL_WHICH_NAMES` in [`pty-service.ts`](../../apps/desktop/src/main/services/pty-service.ts). Add the
   id to the `refreshClis()` loop in `session-service.ts`, or a manual "Locate binary" pick is never read back.
   Optional: `EXTENSION_PREFIXES` if an editor extension bundles the binary.
5. **Runner choice.** Add a line to `runnerFor()` in `session-service.ts`, and rows to
   [`runner-for.test.ts`](../../apps/desktop/src/main/services/runner-for.test.ts).
6. **Launch adapter.** Create `apps/desktop/src/main/agents/myagent.ts` exporting `myagentLaunch(ctx)`, and add a
   `case` to `buildAgentLaunch()` in [`agents/index.ts`](../../apps/desktop/src/main/agents/index.ts). Rules:
   - Use `ctx.binary`. Never hard-code a path.
   - Any config file written into the worktree goes through `writeWorktreeMcpConfig()` (no env block) and
     `excludeLocally()`, and `cleanup()` restores it. Files that must carry the token go under `ctx.configDir` and
     use `styxMcpServer()`, as [`claude.ts`](../../apps/desktop/src/main/agents/claude.ts) does.
   - If the CLI has no system-prompt flag, add it to `PREAMBLE_AGENTS` in `agents/types.ts`.
   - If the first message cannot be passed as an argument, set `typeFirstMessage: true` and Styx types it into the
     terminal, as [`shell.ts`](../../apps/desktop/src/main/agents/shell.ts) does.
7. **Runner wiring (ACP).** Nothing is required, since unknown modes fall back to `MODE_HINTS`. For an exact mapping,
   add a mode table next to `GEMINI_MODES` and register it in `MODE_TABLES` (keyed by agent, so the session's own
   table is tried first) in `resolveAcpMode()`. If the CLI has an `authenticate` method that needs no browser, add it
   to `pickAuthMethod()`. Both are in [`acp-runner.ts`](../../apps/desktop/src/main/services/acp-runner.ts). If the
   CLI's own modes do not ask before edits and commands (OpenCode's `build` allows every tool), give it the rules for
   that session's process, as [`opencode.ts`](../../apps/desktop/src/main/agents/opencode.ts) does through
   `OPENCODE_CONFIG_CONTENT`, rather than editing the user's config.
8. **Sign-in and status.** In [`agent-service.ts`](../../apps/desktop/src/main/services/agent-service.ts): add
   `LOGIN_ARGS`, `INSTALL_GUIDES`, and either `STATUS_ARGS` plus a parser in `probe()`, or a file-based probe like
   `probeGemini()`. Probes return an identity label, never a credential.
9. **Install.** Add `RECIPES.myagent` (darwin, linux, win32) in
   [`agent-install.ts`](../../packages/core/src/model/agent-install.ts), and `CLI_INSTALL_URLS.myagent` (https
   only) in [`packages/core/src/selectors/discovery.ts`](../../packages/core/src/selectors/discovery.ts).
10. **Copy.** In [`packages/core/src/copy.ts`](../../packages/core/src/copy.ts): `agents`, `agentProducts` (this also
    adds the row to Settings › Agents), and `session.permissionModeHintsByAgent` when your CLI's modes differ from
    the generic hints. Write it in the same plain style as the existing entries.
11. **Pickers.** Add the id to `SPAWN_AGENTS` in
    [`modals.ts`](../../apps/desktop/src/renderer/features/modals/modals.ts). This feeds the Spawn modal, the New
    task form, the Tasks board and the design canvas. Add it to `AGENT_OPTIONS` in
    [`apps/desktop/src/renderer/screens/Settings/rows.ts`](../../apps/desktop/src/renderer/screens/Settings/rows.ts)
    (default agent setting).
12. **Colour.** Add `agentMyagent` to both `colorLane` themes in
    [`packages/tokens/tokens.json`](../../packages/tokens/tokens.json), map it in `laneShort` in
    [`packages/tokens/scripts/build.mjs`](../../packages/tokens/scripts/build.mjs), run `pnpm tokens:build`, and add a
    `.dot[data-agent='myagent']` rule to `AgentDot.module.css` and its story. Without this, the dot falls back to the
    shell colour. A new colour is a design decision, so say so in the PR.

### Optional: features that are per agent

13. **One-click setup (onboarding cards).** Add the id to `setupAgentSchema` in
    [`packages/core/src/model/agent-setup.ts`](../../packages/core/src/model/agent-setup.ts). Then fill `TEST_ARGS`,
    `SIGNIN_ARGS`, `PLAN_PAGES` and `PLAN_NAMES` in `agent-setup-service.ts`, and `agentSetup.names`, `plans`,
    `sites` and `accounts` in `copy.ts`.
14. **Skills.** If the CLI reads `SKILL.md` folders, add a host to `skillHostSchema` and `INSTALLABLE_SKILL_HOSTS` in
    [`packages/core/src/model/discovery.ts`](../../packages/core/src/model/discovery.ts), `SKILL_HOST_DIRS` and
    `HOSTS` in [`skills-service.ts`](../../apps/desktop/src/main/services/skills-service.ts), and
    `skills.hosts` / `hostsShort` in `copy.ts`.
15. **Publish drafts.** `agentInvocation()` in
    [`publish-service.ts`](../../apps/desktop/src/main/services/publish-service.ts) runs the agent headless to draft a
    commit or PR message. Return `null` to use the file-list fallback, or add a one-shot invocation and parser.
16. **Hooks.** If the CLI has lifecycle hooks, point them at `styx hook myagent` and map the events in
    `SessionService.onHook()`.
17. **Images, effort, steering.** `acceptsImages()` in `session-service.ts` and `takesEffort()` in
    [`session-controls.ts`](../../apps/desktop/src/renderer/features/chat/session-controls.ts) name specific agents.
    ACP sessions report image support from `initialize`, so most new agents need nothing here.
18. **Demo fixture.** Add a `CliInstall` row (and a session, if you want one on screen) to
    [`packages/core/src/fixtures/demo.ts`](../../packages/core/src/fixtures/demo.ts).

### Docs and website

19. **README.** Add the agent to the "Works with" list and the opening lines in [`README.md`](../../README.md).
20. **Website.** `agents` in [`apps/website/components/Compat.tsx`](../../apps/website/components/Compat.tsx),
    [`apps/website/lib/compare/styx.ts`](../../apps/website/lib/compare/styx.ts) and
    [`apps/website/public/llms.txt`](../../apps/website/public/llms.txt). Maintainers may prefer to do this at release.
21. **Discrepancy log.** A new agent adds UI the handoff prototype does not show (a spawn tile, a colour). Add the
    next numbered row to [`docs/handoff-discrepancies.md`](../handoff-discrepancies.md) (`| # | Where | Prototype |
Spec | Resolution |`) saying what you added and why. Maintainers may renumber it on merge.

You do not need to touch [`packages/core/src/ipc/contract.ts`](../../packages/core/src/ipc/contract.ts). Its
schemas use `agentSchema`, so new ids flow through.

## Testing it

First-time setup is in the README's "Build from source" section (`pnpm install`, `pnpm tokens:build`).

Unit tests and types:

```sh
pnpm typecheck                                   # every package; finds missing Record<Agent, …> keys
pnpm -F @styx/desktop test src/main/agents       # launch adapters
pnpm -F @styx/desktop test src/main/services     # detection, runners, runnerFor, agent services
pnpm -F @styx/core test                          # schemas, selectors, copy
pnpm -F @styx/broker test
pnpm lint
```

Write at least:

- `apps/desktop/src/main/agents/myagent.test.ts`, like `gemini.test.ts`. Cover each launch branch, check the exact
  args, and check that nothing in the worktree contains `STYX_TOKEN` and that `cleanup()` removes what it wrote.
- `runnerFor` rows for every capability combination you rely on.
- A detection test in
  [`detect-service.test.ts`](../../apps/desktop/src/main/services/detect-service.test.ts) for the binary name, the
  version marker and `authState()`.
- If you added a protocol backend, tests against a scripted fake process, like `acp-runner.test.ts`. Never call a
  real CLI or a real model in tests.

End-to-end tests drive the built Electron app with Playwright. `pnpm e2e` runs them, after `pnpm build`.

- [`apps/desktop/e2e/launch.ts`](../../apps/desktop/e2e/launch.ts) puts
  [`apps/desktop/e2e/fixtures/bin/`](../../apps/desktop/e2e/fixtures/bin/) first on `PATH`, so a test never starts a
  real agent or spends anyone's usage.
- Add a fake `fixtures/bin/myagent`: a Node script with a `#!/usr/bin/env node` line, marked executable
  (`chmod +x`). It must answer `--version` and `--help`, and the help text must list the flags your capabilities look
  for. For ACP, copy the scripted session in `fixtures/bin/gemini`.
- Add `fixtures/bin/myagent.cmd` for Windows. Copy `gemini.cmd` and change the script name on its last line.
- The demo fixture's CLI rows point at paths like `/opt/homebrew/bin` and are never re-detected on their own. Your
  spec should call `detect.clis` first, as
  [`acp-session.spec.ts`](../../apps/desktop/e2e/acp-session.spec.ts) does, then spawn through the UI.
- Run one spec with `pnpm e2e -- --grep "<test name>"`.

To try it by hand:

```sh
STYX_FIXTURE=demo STYX_KEYCHAIN=memory pnpm dev
```

This opens sample projects in a temporary database, with an in-memory keychain. Go to Settings › Agents and press
Rescan so your real CLI is detected (fixture rows are not). Then spawn the agent from the Spawn agent modal. Check
that the chat works, an approval shows as a card, and asking it to run `gh auth status` makes a grant request appear.

A good PR includes:

- the launch adapter and its test, the detection changes and their test, and the migration;
- the fake CLI (POSIX and `.cmd`) and an e2e spec that spawns a session and gets one reply;
- `pnpm typecheck && pnpm lint && pnpm test` passing;
- the CLI version you checked the flags against, written in the adapter's header comment. Existing adapters mark
  flags they could not check against a real install as `UNVERIFIED`; do the same;
- a screenshot of the Spawn modal and a running chat;
- the README "Works with" line and a discrepancy-log row.

## Security rules

- **No secrets in the worktree.** `STYX_TOKEN` authenticates the session to the broker. It may sit in the process env
  and in files under `ctx.configDir` (per session, outside the repo), never in a file inside the worktree. Use
  `styxMcpServerInherit()` / `writeWorktreeMcpConfig()` for anything in the repo.
- **No agent credentials in Styx.** Styx reuses the CLI's own login. Detection and probes check whether a credential
  file exists or read an identity label (an email, "API key"). They never read, copy or store the token. Agent
  credentials never go into SQLite, logs, IPC payloads or renderer state.
- **Shims first on `PATH`.** The session env puts the shim directory ahead of the login `PATH`. Do not reorder
  `PATH` or reset it in your launch `env`. The preamble (or Claude's system prompt) tells the agent to use the shims.
  `cloudCliByFullPath()` in `stream-runner.ts` flags commands that call a cloud CLI by full path to get around them.
- **Approvals stay with the user.** Map Styx permission modes conservatively. Plain `default` must ask before edits
  and commands. Never map a mode to the CLI's "approve everything" setting unless the user picked
  `bypassPermissions` or `dontAsk`, and say so in `permissionModeHintsByAgent`.
- **Logs.** Never log CLI stdout or stderr that could carry tokens. Use `logger` from
  [`logger.ts`](../../apps/desktop/src/main/services/logger.ts), which redacts secret-shaped values. Terminal output
  saved to disk goes through `PtyLog`, which masks them too.
- **Access to targets is not the agent's business.** Your adapter must not add provider env vars (`GH_TOKEN`,
  `VERCEL_TOKEN`, …) to the launch env. Agents get provider credentials only through a grant, for the grant's
  lifetime, through the shims or `get_credential`. That path is audited for you.
- Ask for a review from the `security-reviewer` agent
  ([`.claude/agents/`](../../.claude/agents/)) or a maintainer when you touch the launch env, the broker or config
  files.

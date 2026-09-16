# Agent parity: Codex CLI 0.154.0, with Gemini CLI and Cursor CLI

Date: 2026-09-16. Machine: `codex` 0.154.0 (`~/.local/bin/codex` → standalone release), `claude` 2.1.263.
`gemini` and `agent` (Cursor) are not installed here; their sections rest on vendor docs and are marked unverified.

The bar is what Styx gives Claude Code today (§3). The question is how close each other CLI can get, through which
interface, and what it costs. Everything under "verified" was run on this machine; the protocol types come from
`codex app-server generate-ts` on this exact build (711 files), and `docs/research/codex-app-server-probe.mjs` is
the live probe used below (no model turn, so no usage).

## 1. Why Codex "doesn't work" today (evidence)

Styx drives Codex through its terminal UI in a pty (ADR-0010). Two sessions this week show the same picture:

- The pty log of this morning's session (`~/Library/Application Support/Styx/logs/pty/01M2MGHR….log`) shows the
  TUI banner, the model line, and an empty composer with its placeholder. Nothing was ever submitted; the process
  stayed alive at the prompt.
- The process argv has no prompt in it. The message "hey" was typed in Styx's composer two seconds after spawn and
  went in as `pty.write("hey\r")`. The TUI enables the kitty keyboard protocol (`CSI > 7 u` in the log) and treats a
  burst of keys as a paste, so text plus Enter arriving in one write does not submit. Driving a TUI by keystrokes
  is the wrong interface: the CLI has two structured ones (§2.3, §2.4).
- Yesterday's session also showed "1 MCP startup issue" because Codex started `styx mcp` with an empty `STYX_EXE`
  (`env: : No such file or directory` in Codex's own log). The current build forwards the env names and this
  morning's session connected to the broker over MCP. That part is fixed.
- Settings › Agents says "check failed" for Codex because `codex login status` prints `Logged in using ChatGPT` on
  **stderr** and the verifier reads stdout only. The app-server `account/read` returns the email and plan
  directly (§2.4) and is the better source.

## 2. Codex CLI surface (verified on 0.154.0)

### 2.1 Interactive TUI (`codex [OPTIONS] [PROMPT]`)

Flags that matter: `-c key=value` (TOML-parsed config overrides, repeatable), `-m/--model`, `-s/--sandbox
read-only|workspace-write|danger-full-access`, `-a/--ask-for-approval on-request|never`, `--approve-for-me`
(auto-review approvals in workspace-write), `--dangerously-bypass-approvals-and-sandbox`, `-C/--cd`, `--add-dir`,
`--worktree`, `--search`, `-i/--image`, `--no-alt-screen`, `-p/--profile`, `--enable/--disable <feature>`.
Subcommands: `exec`, `review`, `login`, `mcp`, `app-server`, `resume`, `fork`, `queue`, `agents`, `apply`,
`doctor`, `sandbox`, `features`, `plugin`, `cloud`.

Only useful to Styx as a pop-out terminal. Not a control surface.

### 2.2 Config keys (via `-c` or `~/.codex/config.toml`)

`model`, `model_reasoning_effort`, `model_reasoning_summary`, `approval_policy`, `approvals_reviewer`,
`sandbox_mode`, `sandbox_workspace_write.network_access`, `mcp_servers.<name>.{command,args,env,env_vars}`
(`env_vars` = names forwarded from Codex's own environment; verified yesterday with `codex mcp list`), `notify`
(external command per turn, what Styx uses today), `hooks`, `projects."<path>".trust_level`, `profiles`,
`features`, `web_search`. Per-thread overrides are also accepted on `thread/start.config`.

### 2.3 `codex exec` (one process per turn)

`codex exec --json [PROMPT]` streams JSONL: `thread.started {thread_id}`, `turn.started`, `item.started|updated|
completed`, `turn.completed|failed`, `error`. `codex exec resume <thread-id> [PROMPT]` continues a thread in a new
process. `--output-last-message FILE`, `--output-schema`, `-i` images, same `-c/-m/-s/-a` flags. Non-interactive:
nothing can ask; the sandbox decides, failures go back to the model. Same shape as Styx's cursor `argv` stream
runner. A fallback, not the target: no approvals, no questions, no steering, no live settings.

### 2.4 `codex app-server` (the target)

Newline-delimited JSON-RPC 2.0 over stdio (`--listen unix://…` and `ws://` also exist; a shared daemon is
optional). Verified live on this machine with the probe:

```
initialize {clientInfo, capabilities:{experimentalApi:true}} → {userAgent, codexHome, platformFamily, platformOs}
initialized (notification)
model/list {includeHidden} → models with efforts, input modalities, default flag
account/read → {account:{type:"chatgpt", email:"nicholas…@gmail.com", planType:"team"}}
getAuthStatus → {authMethod:"chatgpt"}
account/rateLimits/read → 5 h and 7 d windows: usedPercent, resetsAt, planType
thread/start {cwd, ephemeral, sandbox, approvalPolicy} → thread + `thread/started`; MCP servers start per thread
skills/list {cwds} · permissionProfile/list
```

Client → server requests (all typed): `thread/start | resume | fork | list | read | archive | delete | compact/start
| rollback | revert | name/set | items/list | turns/list`, `turn/start | steer | interrupt`, `review/start`,
`model/list`, `account/read | rateLimits/read | login/start | logout`, `skills/list`, `hooks/list`, `config/read |
value/write`, `mcpServerStatus/list`, `gitDiffToRemote`, `fuzzyFileSearch`, `command/exec`.

Server → client **requests** (the client must answer): `item/commandExecution/requestApproval` (decision
`accept | acceptForSession | decline | cancel`, plus execpolicy / network amendments), `item/fileChange/
requestApproval` (same decisions), `item/tool/requestUserInput` (questions with `header`, `question`, `options`,
`isOther`, `isSecret`; answer = `{answers:{[id]:{answers:[…]}}}`), `item/permissions/requestApproval` (granular
network / filesystem grants, scope `turn | session`), `mcpServer/elicitation/request`, `item/tool/call`.

Notifications: `thread/started | status/changed {idle | active[waitingOnApproval | waitingOnUserInput] |
systemError} | tokenUsage/updated | compacted | settings/updated | closed`, `turn/started | completed {status:
completed | interrupted | failed, error} | diff/updated | plan/updated`, `item/started | completed` with the item
union below, `item/agentMessage/delta`, `item/reasoning/summaryTextDelta | textDelta | summaryPartAdded`,
`item/commandExecution/outputDelta`, `item/fileChange/patchUpdated | outputDelta`, `item/mcpToolCall/progress`,
`item/plan/delta`, `error {error, willRetry}`, `account/rateLimits/updated`, `model/rerouted`,
`mcpServer/startupStatus/updated`, `hook/started | completed`.

Items (`ThreadItem`): `userMessage`, `agentMessage {text, phase: commentary | final_answer}`, `reasoning {summary,
content}`, `commandExecution {command, cwd, status, aggregatedOutput, exitCode, durationMs, commandActions}`,
`fileChange {changes:[{path, kind, diff}], status}`, `mcpToolCall {server, tool, arguments, result, error}`,
`dynamicToolCall`, `webSearch`, `plan`, `imageView`, `contextCompaction`, `enteredReviewMode | exitedReviewMode`,
`subAgentActivity`, `collabAgentToolCall`.

Turn parameters (`turn/start`): `input: [{type:"text"} | {type:"localImage", path} | {type:"image", url} |
{type:"mention", name, path} | {type:"skill"}]`, `model`, `effort`, `summary`, `approvalPolicy`, `sandboxPolicy`,
`cwd`, `outputSchema`, `personality`. Every setting can change per turn; `thread/settings/updated` confirms.

Models on this account (`model/list`, hidden included):

| id                                  | efforts                                   | default effort | inputs      |
| ----------------------------------- | ----------------------------------------- | -------------- | ----------- |
| gpt-6-astra (default)               | low · medium · high · xhigh · max · ultra | low            | text, image |
| gpt-5.6-sol · gpt-5.6-terra         | low … ultra                               | medium         | text, image |
| gpt-5.6-luna · gpt-reserve (hidden) | low … max                                 | medium         | text, image |
| gpt-5.5                             | low · medium · high · xhigh               | xhigh          | text, image |
| codex-auto-review (hidden)          | low … max                                 | medium         | text, image |

### 2.5 Sandbox and approval model

`AskForApproval = untrusted | on-request | never | {granular:{sandbox_approval, rules, skill_approval,
request_permissions, mcp_elicitations}}`. `SandboxPolicy = readOnly{networkAccess} | workspaceWrite{writableRoots,
networkAccess, …} | dangerFullAccess | externalSandbox`. `ApprovalsReviewer = user | auto_review |
guardian_subagent` (the `--approve-for-me` path). A file edit inside `workspaceWrite` roots never asks; a command
that needs to leave the sandbox asks (`requestApproval` with `reason`); under `never` it fails back to the model.

## 3. What Styx gives Claude Code today (the bar)

From `agents/claude.ts`, `services/stream-runner.ts`, `session-service.ts`, the chat pane and rows #54, #55, #57:

- **Transport**: `claude -p --input-format stream-json --output-format stream-json` over pipes (NDJSON both ways).
- **Init**: CLI session id (for `--resume` on relaunch), model, permission mode, slash-command list.
- **Transcript**: user / agent (Markdown) / thinking / tool rows with tool results; streaming text and thinking
  deltas with a live cursor, reconciled by the final message; system lines.
- **Usage**: cost USD, turns, duration, output tokens; rate-limit events as a note.
- **Asks**: permission prompts (`can_use_tool`) → allow / deny with a hint; `AskUserQuestion` → question sets
  answered together; `ExitPlanMode` → plan approval; all mirrored on the board, inbox, toast and badge.
- **Live controls**: model (`set_model`), permission mode (`set_permission_mode`), effort (next launch),
  interrupt, stop, pause / resume; Spawn modal and project defaults for the same.
- **State**: hooks (`SessionStart`, `Stop`, `Notification`, …) drive working / idle / needs-you and hunk rescans.
- **Attachments**: images as image blocks; files inlined; `@file` and `/command` completion.
- **Styx MCP + shims**: `request_access`, `ask_user`, `report_status`, peers, `remember_command`; cloud CLIs via
  the grant broker; compaction boundary noted; pop-out chat window.
- **Agents page**: verify via `claude auth status --json`, sign-in in a pty.

## 4. Parity matrix

✓ = same as Claude · ◐ = partial · ✗ = not possible · (mapping in §5)

| Capability                       | Claude (today) | Codex via TUI in a pty (today)    | Codex via `app-server`                                                                            | Codex via `exec --json`  |
| -------------------------------- | -------------- | --------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------ |
| Send a message reliably          | ✓              | ✗ (keystroke burst, see §1)       | ✓ `turn/start`                                                                                    | ✓ new process per turn   |
| First message on spawn           | ✓              | ◐ positional prompt, unverified   | ✓                                                                                                 | ✓                        |
| Streaming text                   | ✓              | ✗ (raw TUI frames)                | ✓ `agentMessage/delta`                                                                            | ◐ item events, no deltas |
| Thinking / reasoning             | ✓              | ✗                                 | ✓ `reasoning/*Delta` (summaries; effort permitting)                                               | ◐                        |
| Tool rows (commands, edits, MCP) | ✓              | ✗                                 | ✓ `commandExecution` (+ output deltas, exit code), `fileChange` (per-file diffs), `mcpToolCall`   | ◐                        |
| Permission asks                  | ✓              | ✗ (buried in TUI)                 | ✓ `commandExecution/requestApproval`, `fileChange/requestApproval`, `permissions/requestApproval` | ✗ (never asks)           |
| Agent questions                  | ✓              | ✗                                 | ✓ `tool/requestUserInput` (headers, options, secret fields)                                       | ✗                        |
| Plan approval                    | ✓              | ✗                                 | ◐ plan items stream (`item/plan/delta`); no gate equivalent to `ExitPlanMode`                     | ✗                        |
| Model switch, live               | ✓              | ✗                                 | ✓ per turn (`turn/start.model`), catalogue from `model/list`                                      | ◐ per process            |
| Effort switch, live              | ◐ next launch  | ✗                                 | ✓ per turn, per-model options                                                                     | ◐ per process            |
| Permission mode switch, live     | ✓              | ✗                                 | ✓ per turn (`approvalPolicy` × `sandboxPolicy`)                                                   | ◐                        |
| Interrupt                        | ✓              | ◐ Ctrl-C                          | ✓ `turn/interrupt`                                                                                | ◐ kill                   |
| Steer mid-turn                   | ✗              | ✗                                 | ✓ `turn/steer` (Codex has more here)                                                              | ✗                        |
| Resume after relaunch            | ✓ `--resume`   | ✗                                 | ✓ `thread/resume`                                                                                 | ✓ `exec resume`          |
| Usage                            | ✓ cost USD     | ✗                                 | ◐ tokens + context window (`tokenUsage/updated`); no USD on ChatGPT plans                         | ◐                        |
| Rate limits                      | ✓              | ✗                                 | ✓ `account/rateLimits/*` (5 h / 7 d windows)                                                      | ✗                        |
| Compaction                       | ✓ noted        | ✗                                 | ✓ `thread/compact/start` + `thread/compacted`                                                     | ✗                        |
| Slash commands                   | ✓ from CLI     | ◐ TUI's own                       | ◐ Styx-provided list: /compact, /review, /model, /diff                                            | ✗                        |
| Images                           | ✓              | ✗                                 | ✓ `localImage`                                                                                    | ✓ `-i`                   |
| Files / mentions                 | ✓              | ✗                                 | ✓ `mention` items                                                                                 | ◐ inline                 |
| Working / idle / needs-you       | ✓ hooks        | ◐ `notify` hook + pty quiet timer | ✓ `turn/*`, `thread/status/changed`                                                               | ✓                        |
| Hunk rescans after edits         | ✓              | ◐                                 | ✓ `fileChange` completed                                                                          | ✓                        |
| Styx MCP tools + shims           | ✓              | ✓ (fixed yesterday)               | ✓ same `-c mcp_servers.styx.*`                                                                    | ✓                        |
| Agents page identity             | ✓              | ✗ stderr bug                      | ✓ `account/read` (email, plan)                                                                    | –                        |
| Skills                           | ✓ files        | ✓ files                           | ✓ + `skills/list`                                                                                 | –                        |
| Review                           | ✗              | ◐ TUI                             | ✓ `review/start` (Codex has more here)                                                            | ✓ `exec review`          |
| Terminal view of the run         | ✓ rendered     | ✓ (it _is_ the TUI)               | ✓ rendered like Claude                                                                            | ✓                        |

Net: the app-server closes every row except cost in USD and an exact plan-approval gate, and adds three things
Claude does not have in Styx (steering, review, per-turn settings).

## 5. Mapping details for the app-server runner

**Process**: one `codex app-server` per session over pipes (same transport as Claude), launched with
`-c mcp_servers.styx.command/args/env_vars` and `-C <worktree>`; no `notify`, no `projects.*.trust_level`
(TUI-only concerns). `initialize` with `clientInfo {name:"styx", version}` and `capabilities.experimentalApi:true`
(the v2 thread/turn API is gated on it).

**Session start**: `thread/start {cwd: worktree, model, approvalPolicy, sandbox, config:{model_reasoning_effort}}`;
store `thread.id` in `sessions.cliSessionId`; relaunch = `thread/resume {threadId}`. Then `turn/start` with the
first message. Later user messages: `turn/start` when idle, `turn/steer` while a turn is in progress (new:
Claude has no equivalent, Styx today ignores input while working).

**Permission modes** (Styx `permissionMode` → Codex, chosen at spawn and switchable per turn):

| Styx mode         | approvalPolicy | sandbox                             | reviewer    | Effect                                                                            |
| ----------------- | -------------- | ----------------------------------- | ----------- | --------------------------------------------------------------------------------- |
| default           | on-request     | workspaceWrite (worktree + project) | user        | edits inside the worktree run; commands that leave the sandbox ask                |
| acceptEdits       | on-request     | workspaceWrite                      | user        | same as default for Codex (edits never ask in workspace-write); label it honestly |
| plan              | on-request     | readOnly                            | user        | read-only exploration; the plan streams as `plan` items                           |
| bypassPermissions | never          | dangerFullAccess                    | user        | nothing asks, no sandbox                                                          |
| dontAsk           | never          | workspaceWrite                      | user        | anything that would ask fails back to the model                                   |
| auto              | on-request     | workspaceWrite                      | auto_review | Codex's own reviewer decides (`--approve-for-me`)                                 |

The `autoApproveEdits` toggle stays a Styx-side auto-answer for `fileChange/requestApproval`; `mayRequestTargets`
is unchanged (styx MCP).

**Asks**: `commandExecution/requestApproval` → Styx permission ask (allow → `accept`, allow always →
`acceptForSession`, deny → `decline`); `fileChange/requestApproval` → same; `tool/requestUserInput` → Styx question
set (`isSecret` fields need a masked input, `isOther` a free-text row); `permissions/requestApproval` → an ask
listing the requested network / filesystem additions, answered with the same profile and scope;
`mcpServer/elicitation/request` from third-party MCP servers → decline unless a form can be rendered.

**Transcript**: `agentMessage` (delta stream → final text; `phase: commentary` renders as an interim line),
`reasoning` (summary deltas → thinking rows), `commandExecution` (tool row: command, live output, exit code),
`fileChange` (tool row with per-file diffs → hunk rescan when tracking is on), `mcpToolCall` (tool row; styx tools
show their result), `plan`, `webSearch`, `contextCompaction` (system line), `error` (system line; `willRetry`).

**State machine**: `turn/started` → activity; `turn/completed` → quiet (note = last agent message);
`thread/status/changed {active:[waitingOnApproval | waitingOnUserInput]}` → needs-you via the open ask;
`systemError` / `process exit` → paused with a banner; `account/rateLimits/updated` → note.

**Controls**: `session.configure {model, effort, permissionMode}` applies to the next `turn/start` (no relaunch);
the composer's model and effort options come from `model/list` per session, not from the Claude alias table
(`effortSchema` and `MODEL_ALIASES` are Claude-shaped today and need an agent-aware catalogue).

**Usage**: `tokenUsage.total` (input / output / total, context window) shown as tokens; cost line hidden for
ChatGPT accounts.

**Agents page**: verify Codex through `account/read` + `getAuthStatus` (email, plan type, auth method); sign-in
stays `codex login` in a pty (or `account/login/start`, which returns a URL for the device flow).

**Fixtures for tests**: one real turn ("reply with the single word pong") recorded through the probe gives the
exact notification stream for table-driven parser tests; it costs one tiny request on the account.

## 6. Gemini CLI and Cursor CLI (docs only, not installed here)

Both also have a structured interface, and it is the same one: the **Agent Client Protocol** (ACP, JSON-RPC over
stdio, the protocol Zed uses).

- **Gemini CLI**: `gemini --acp`. ACP methods per the docs: `session/new`, `session/prompt`, `session/cancel`,
  `session/request_permission` (server → client), `session/set_mode` (approval level) and model switching.
  Headless alternative: `gemini -p … --output-format stream-json` (one-shot). `--approval-mode default | auto_edit
| yolo | plan`. Styx today: pty with `-i <prompt>` (unverified flags, ADR-0010).
- **Cursor CLI** (`agent`): `agent -p --output-format stream-json` (+ `--stream-partial-output` for deltas,
  `--resume <chat-id>`, `--force` to apply edits, `--model`) — Styx's existing `argv` stream runner. ACP: `session/new`,
  `session/load`, modes `agent | plan | ask`, `session/request_permission` answered `allow-once | allow-always |
reject-once`.

One ACP runner would therefore lift both Gemini and Cursor off the pty with the same rows as §4, leaving `pty` for
the shell only.

## 7. Recommendation

1. **Codex on the app-server** (supersedes ADR-0010 for Codex): a JSON-RPC runner beside the Claude stream runner,
   reusing the same effect pipeline (transcript, streaming, asks, state). Deliverables: `agents/codex.ts` launch,
   `services/app-server-runner.ts` (client + mapping), per-agent model / effort catalogue in the read model and the
   composer, `session.configure` per turn, resume via `thread/resume`, token usage + rate limits, Agents page verify
   via `account/read`, recorded-fixture parser tests, e2e with a fake `codex` binary speaking the protocol,
   ADR-0016. Roughly a day of agent work.
2. **ACP runner** for Gemini and Cursor, same shape, once either CLI is installed to verify against.
3. **Now, regardless**: read stderr in the Codex verifier; send text and Enter as two writes for the remaining pty
   sessions (shell, and any CLI too old for a structured mode).

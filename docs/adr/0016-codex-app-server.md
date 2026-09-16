# ADR-0016 Codex sessions run through `codex app-server`, not its TUI

Status: accepted · 2026-09-16 (supersedes ADR-0010 for Codex; research in docs/research/agent-parity.md)

## Context

ADR-0010 put Codex on the `pty` runner: its TUI in xterm, driven by keystrokes, with a `notify` hook for idle
detection. It never worked from Styx. The pty logs show why: the TUI enables the kitty keyboard protocol and treats
a burst of keys as a paste, so text plus Enter written in one go never submits, and everything the agent does
(tool calls, approvals, questions, usage) is buried in terminal frames Styx cannot read. `codex exec --json` streams
events but is one process per turn and can never ask — no approvals, no questions, no steering, no live settings.

Codex 0.154 has a third interface, `codex app-server`: JSON-RPC 2.0, newline-delimited over stdio (verified live on
this machine; the protocol bindings were generated from this exact build). It has everything the Claude Code stream
runner gives Styx today and three things it does not: steering a running turn, per-turn settings, and a review.

## Decision

A Codex session is one `codex app-server` process over child_process pipes (the same transport as Claude), chosen
when the CLI's `--help` lists `app-server` (`capabilities.appServer` → `runnerFor` = `stream`); older builds keep
the TUI. The `AppServerRunner` is a second backend on the `RunnerMux` beside Claude's NDJSON runner and emits the
same `StreamEffect`s, so the chat pane, board, inbox, toast, badge and the session state machine work unchanged.

**Lifecycle**: `initialize {clientInfo: styx, capabilities: {experimentalApi: true}}` → `initialized` →
`model/list {includeHidden}` (the catalogue lands on the CLI row so the pickers offer Codex's models and per-model
efforts, `ultra` included) → `thread/start {cwd, model, approvalPolicy, sandbox, config.model_reasoning_effort}`,
or `thread/resume {threadId}` on a relaunch (`Session.cliSessionId`; a refused resume starts a fresh thread) →
`turn/start` per user message with the settings of that moment, `turn/steer {expectedTurnId}` while a turn is
running (a stale id falls back to `turn/start`), `turn/interrupt` for Stop. `/compact` → `thread/compact/start`,
`/review` → `review/start` on the uncommitted changes; other slash text goes to the model. Images are written to a
per-session temp dir and sent as `localImage`. The styx MCP server rides in as `-c mcp_servers.styx.*` with its env
forwarded by name (never a token on argv); no `notify` hook — `turn/started` / `turn/completed` drive the machine.

**Permission mode → Codex** (applied at `thread/start` and re-sent on every `turn/start`, so a live switch takes
effect on the next turn without a relaunch; `codexPolicy` in `agents/codex.ts`):

| Styx mode         | approvalPolicy | sandbox                             | reviewer    |
| ----------------- | -------------- | ----------------------------------- | ----------- |
| default           | on-request     | workspaceWrite (worktree only)      | user        |
| acceptEdits       | on-request     | workspaceWrite                      | user        |
| plan              | on-request     | readOnly                            | user        |
| bypassPermissions | never          | dangerFullAccess                    | user        |
| dontAsk           | never          | workspaceWrite                      | user        |
| auto              | on-request     | workspaceWrite                      | auto_review |

`workspaceWrite` is the session's worktree only, with **network off** (Codex's own default; security review
2026-09-16). The project's main checkout is never a writable root: a write there would bypass the hunk review,
which is worktree-scoped. A command that needs the network is denied by the sandbox and comes back as a
`commandExecution/requestApproval` to rerun outside it, which is exactly the ask Styx shows for it. That covers
the styx shims too: they reach the broker over a unix socket, which the sandbox blocks, so a `gcloud …` inside the
sandbox fails, Codex asks to rerun it unsandboxed, and after the user's Allow the shim and the grant flow proceed
as for any other agent. The price is one extra ask per network command in `default`; the alternative (network on)
would let `curl` exfiltrate anything readable without any ask, which the grant model cannot see.

**Auto-approve edits** (the session toggle) is enforced on the Styx side for every runner: only when every path the
request names resolves inside the session's worktree, none is `.styx/project.json`, and at least one path is
present. A Codex `fileChange` approval only ever arrives for a path outside the sandbox, so with the toggle on it
still asks. Stop (interrupt) declines every open approval before `turn/interrupt`, so a later Allow cannot run
what the user stopped.

**Asks**: `item/commandExecution/requestApproval` → a `Bash` permission (allow → `accept`, allow-always →
`acceptForSession`, deny → `decline`); `item/fileChange/requestApproval` → an `Edit` permission naming the
item's paths, so the session's auto-approve-edits toggle applies (never for `.styx/project.json`);
`item/tool/requestUserInput` → a question set (`isSecret` fields are masked and their answers are never persisted —
the row keeps `••••••`, the CLI gets the text); `item/permissions/requestApproval` → a decision answered with the
same profile for the turn; MCP elicitations are declined; `item/tool/call`, token refresh and attestation
requests get a JSON-RPC method-not-supported error.

**Transcript**: `agentMessage` deltas stream into an agent row reconciled by the completed item; reasoning
summaries stream as thinking; `commandExecution` / `fileChange` / `mcpToolCall` / `webSearch` are tool rows
(`Bash`, `Edit`, `mcp__<server>__<tool>`, `WebSearch`) patched by their results, with live command output in the
terminal view; plans land as agent rows; compaction as a system line; `error` notifications as error lines.

**Usage**: `thread/tokenUsage/updated` totals and the context window ride on the session (`tokensUsed`,
`contextWindow`); the meta line shows tokens where Claude shows dollars. Rate-limit windows above 80% become the
session note.

**Agents page**: Codex is verified through a short-lived app-server (`account/read` → `email · plan`, `model/list`
→ the catalogue on the row); a build without one is asked `codex login status`, read from stdout **and** stderr
(Codex prints its answer on stderr).

## Not at parity (deliberate)

- **Cost in USD**: ChatGPT plans report tokens, not dollars; `costUsd` stays 0 and the meta shows tokens.
- **Plan gate**: Codex has no `ExitPlanMode`; `plan` mode is a read-only sandbox and plans stream as rows, there is
  no approve/reject step before the agent continues.
- **acceptEdits** is the same as `default` for Codex: edits inside the workspace never ask in `workspaceWrite`.
- **MCP elicitations** from third-party servers are cancelled rather than rendered.
- **Allow always** (`acceptForSession`) is honoured when an ask sends `always: true`; the ask card does not offer it yet.

## Rejected

`codex exec --json` (no asks, no steering, a process per turn); keeping the TUI and typing slower (still no
structured transcript); a shared app-server daemon (`--listen`; one process per session is simpler to kill and
audit and matches the Claude runner).

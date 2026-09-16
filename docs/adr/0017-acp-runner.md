# ADR-0017 Gemini CLI and Cursor agent sessions run over the Agent Client Protocol

Status: accepted · 2026-09-16 (supersedes ADR-0010 for Gemini and Cursor; research in docs/research/agent-parity.md §6)

## Context

ADR-0010 put Gemini CLI on the `pty` runner (its TUI in xterm, `-i <prompt>` for the first message, a 3 s quiet
timer for idle) and Cursor's `agent` on the one-shot `argv` stream runner (`--print --output-format stream-json`,
one process per turn, `--resume <chatId>`). Neither gives Styx what the Claude runner gives it: the pty hides tool
calls and approvals inside terminal frames, and print mode can never ask — no permission prompts, no live settings,
no interrupt short of killing the process. Both CLIs write the styx MCP server into a config file in the worktree
(`.gemini/settings.json`, `.cursor/mcp.json`), which has to be excluded from git and restored on exit.

Both CLIs also speak the **Agent Client Protocol** (ACP, the protocol Zed uses): JSON-RPC 2.0, newline-delimited
over stdio, with `gemini --acp` and `agent acp`. It is one protocol for two agents: `initialize`, `session/new` /
`session/load`, `session/prompt`, `session/cancel`, `session/set_mode`, `session/update` notifications for text,
thoughts, tool calls, plans and commands, and `session/request_permission` as an agent → client request that the
client answers. MCP servers are handed over in `session/new`, so nothing needs to be written into the worktree.

## Decision

A Gemini or Cursor session is one `gemini --acp` / `agent acp` process over child_process pipes when the CLI's
`--help` mentions `--acp` or an `acp` subcommand (`capabilities.acp` → `runnerFor` = `stream`); older builds keep
their previous launches (Gemini pty, Cursor print mode or pty). The `AcpRunner` is the third backend on the
`RunnerMux` beside Claude's NDJSON runner (`stdin` / `argv`) and Codex's app-server runner, and emits the same
`StreamEffect`s, so the chat pane, board, inbox, toast, badge and the session state machine work unchanged.

**Lifecycle**: `initialize {protocolVersion: 1, clientCapabilities: {fs: {readTextFile: false, writeTextFile:
false}, terminal: false}, clientInfo: styx}` → `session/load {sessionId, cwd, mcpServers}` on a relaunch when the
agent advertises `loadSession` (a refused load starts a new session with a terminal line), else `session/new {cwd:
worktree, mcpServers: [styx stdio entry, env as `{name, value}` pairs]}` → the Styx permission mode via
`session/set_mode` → `session/prompt` per user message. ACP has no steer: a message typed mid-turn waits in a queue
and goes out when the `session/prompt` response lands. `session/cancel` is Stop (a permission still waiting on the
user is answered `cancelled` first, as the spec asks). Slash text matching a command from
`available_commands_update` is sent as-is; the agent runs it. Images become `{type: 'image', data, mimeType}`
blocks when `promptCapabilities.image` is true, otherwise they are dropped with a system row. History replayed by
`session/load` is ignored (Styx keeps its own transcript).

**Auth**: an `auth_required` error from `session/new` (`-32000` / `data.reason`) triggers one `authenticate` with a
method Styx can complete without a browser — Gemini's `gemini-api-key` when `GEMINI_API_KEY` is set, `vertex-ai`
when `GOOGLE_API_KEY` / `GOOGLE_CLOUD_PROJECT` is, Cursor's `cursor_login` (its documented step; it reuses the
`agent login` credentials) — then retries. Anything else (Google sign-in) ends the launch with "Sign in with
{cli} first" and the CLI-missing banner; nothing interactive is driven from Styx.

**Client methods**: `session/request_permission` is answered; `fs/*` and `terminal/*` were not advertised and are
refused with JSON-RPC `-32601`, so the agent uses its own tools. Every inbound message is zod-parsed with compact
schemas (method + the fields read); unknown update kinds are logged at debug and dropped.

**Permission mode → agent mode** (`resolveAcpMode`, applied at spawn and on every `session.configure`; the ids come
from `session/new.modes.availableModes`, or from a `mode`-category config option on a v2-style agent, in which case
the switch goes through `session/set_config_option`):

| Styx mode         | Gemini (`default · auto_edit · yolo · plan`) | Cursor (`agent · plan · ask`) |
| ----------------- | -------------------------------------------- | ----------------------------- |
| default           | default                                      | agent                         |
| acceptEdits       | auto_edit                                    | agent                         |
| plan              | plan (only when Gemini has plan mode on)     | plan                          |
| bypassPermissions | yolo                                         | agent                         |
| dontAsk           | yolo                                         | agent                         |
| auto              | yolo                                         | agent                         |

Cursor's `ask` (Q&A only) is not a Styx mode and is never selected. Cursor distinguishes only agent vs plan from
Styx's side; every `session/request_permission` in agent mode still opens a Styx ask, and the `autoApproveEdits`
toggle keeps auto-answering edit-kind requests in main. When an agent offers ids Styx does not know, the closest by
id or name is chosen and a system row says so ("permissions: X → Y (closest this agent offers)"); when nothing fits
the mode stays put with a row naming the current one; a refused `set_mode` is reported, not thrown.

**Transcript**: `agent_message_chunk` → a live text block (`streamStart` / `streamDelta` per chunk, `streamStop` +
`streamFinal` when the kind changes, a tool call lands, or the prompt ends); `agent_thought_chunk` → a thinking
block the same way; `tool_call` → a tool row in the Claude vocabulary (`execute` → Bash, `edit` → Edit, `read` →
Read, `search` → Grep, `fetch` → WebFetch, `delete` / `move` → Bash, `think` → Task, `other` → the title) with
`rawInput` as the input, `locations[0]` as `file_path` and the title as a Bash command when the input has none;
`tool_call_update` with `completed` / `failed` → `toolResult` (detail = the first line of the update's text
content) and a hunk rescan for edit kinds; `plan` / `plan_update` → an agent row listing the entries with ☑ ▸ ☐ ✕;
`available_commands_update` → the session's `/` list (an `init` refresh with the same chat id);
`current_mode_update` → the session note; `config_option_update` → the model catalogue; `usage_update` → tokens
and context window. The `session/prompt` response ends the turn: `— done (stopReason) in N s`, the note from the
last text, `usage {costUsd: null, numTurns, durationMs}`, quiet.

**Asks**: `session/request_permission` → a `permission` effect (requestId = the JSON-RPC id as a string; toolName
from the tool call's kind; input = rawInput + title + locations). Allow answers the agent's `allow_once` option
(`allow_always` when main passes `updatedInput.always`); deny answers `reject_once` — `reject_always` is never
chosen; when the agent offered no fitting option the answer is `{outcome: 'cancelled'}`, which the spec forbids it
to treat as approval.

**Controls**: `setPermissionMode` → `session/set_mode` (or the mode config option); `setModel` →
`session/set_config_option` on the `model`-category option when the agent lists one, or Gemini's `session/set_model`
when `session/new` returned a `models` block, else a system row "model switching is not offered by this agent";
`setEffort` → a terminal line only (ACP has no effort); `interrupt` → `session/cancel`; `kill` → end stdin, kill.

**Launches** (`agents/gemini.ts`, `agents/cursor.ts`): ACP is `gemini --acp [-m model]` and `agent [--model m] acp`
(Cursor's global flags precede the subcommand) with `stream: {kind: 'acp'}` and no worktree config file — the styx
server travels in `session/new`, so the L5 concern (no token in the repo) is met by construction. The pty and
print fallbacks keep their config-file merging and `cleanup`.

## Unverified

Neither `gemini` nor `agent` is installed on the verifying machine. The runner is verified against the ACP
specification (v1 shapes; the v2 field names it accepts where the cost is a line) and two fakes: the PassThrough
agent in `services/acp-runner.test.ts` and the executable `e2e/fixtures/bin/gemini`, which the e2e
`acp-session.spec.ts` drives through spawn → `pong` → a permission ask → Allow → a live mode switch → a second turn
that runs without an ask in YOLO. Still to confirm against the real CLIs: that `gemini --help` / `agent --help`
mention the flag as DetectService expects; Gemini's exact `authMethods` ids (`oauth-personal`, `gemini-api-key`,
`vertex-ai` per its source) and whether `session/new` returns `models` or a config option on 0.39; Cursor's
`cursor_login` behaviour when `agent login` has not been run; whether either agent sends `plan` (v1) or
`plan_update` (v2); the shape of `tool_call.content` for command output. The first real session should be recorded
through the runner's terminal rendering and turned into a table-driven fixture, as the Codex probe was.

## Rejected

- Keeping Gemini on the TUI and Cursor on print mode with a smarter typing heuristic: fixes nothing about asks.
- Gemini's `-p … --output-format stream-json`: one-shot, no input stream, no approvals — the same dead end as
  `codex exec --json`.
- Advertising `fs` / `terminal` client capabilities so the agent edits and runs through Styx: it would make Styx
  the sandbox and the auditor of every file write, which the hunk watcher and the shim broker already cover from
  the outside; declining keeps the agent's own tools (and their permission requests) on the path Styx sees.
- A separate runner per CLI: the protocol is the same; only the mode ids differ, and those are data.

import { copy } from '@styx/core';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { styxBin, styxMcpServer, type AgentLaunch, type AgentLaunchContext } from './types';

/**
 * Claude Code: temp `--mcp-config` (styx MCP server) + `--settings` with hooks that forward lifecycle events
 * through `styx hook claude`.
 *
 * VERIFIED 2026-09-06 against `claude` 2.1.263 (`claude --help`, plus `strings` of the native binary for hidden flags
 * and wire shapes):
 * - `--mcp-config <configs...>`, `--settings <file-or-json>`, `--model <alias|full>`, `--effort <low|medium|high|xhigh|max>`,
 *   `--permission-mode <acceptEdits|auto|bypassPermissions|manual|dontAsk|plan>`, `--resume <session-id>`,
 *   `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions` (only *allows* a later live switch to
 *   bypass without enabling it): listed in --help. Styx's `default` mode passes no `--permission-mode` (the CLI's
 *   own default; `manual` is not a Styx mode).
 * - `--include-partial-messages` (print + stream-json only): emits `{type:'stream_event', event, session_id,
 *   parent_tool_use_id}` lines wrapping the Messages API streaming events (`message_start`, `content_block_start`,
 *   `content_block_delta` with text_delta / thinking_delta / signature_delta / input_json_delta,
 *   `content_block_stop`, `message_delta` with usage, `message_stop`) *before* the complete `assistant` event that
 *   carries the same blocks. Subagent output has a non-null `parent_tool_use_id`. Parsed in stream-runner.ts.
 * - `-p/--print`, `--input-format stream-json`, `--output-format stream-json`, `--verbose`,
 *   `--replay-user-messages`, `--include-hook-events`: listed in --help (stream-json input is print-only).
 * - `--permission-prompt-tool`: NOT in --help but present in the binary (hidden flag used by the Agent SDK). The
 *   `stdio` value routes permission prompts as `control_request{subtype:'can_use_tool'}` lines on stdout and expects
 *   a `control_response` on stdin (see stream-runner.ts).
 * - control_request subtypes: `set_permission_mode`, `set_model`, `interrupt` (client→CLI, stdin) and `can_use_tool`
 *   (CLI→client, stdout). `AskUserQuestion` and `ExitPlanMode` arrive as `can_use_tool` too: the answer / approval is
 *   an allow with `updatedInput` (questions + answers) or a deny with a message (keep planning).
 * - stream events: `system` subtypes `init` (`session_id`, `model`, `permissionMode`, `tools`, `cwd`) and
 *   `compact_boundary` (`compact_metadata: {trigger, pre_tokens, post_tokens}`), `stream_event` (partial deltas),
 *   `rate_limit_event` (`rate_limit_info: {status, rateLimitType, resetsAt}`), `result` (`total_cost_usd`,
 *   `num_turns`, `duration_ms`, `session_id`, `usage`).
 * - Hook event names (Stop, SessionEnd, SessionStart, Notification, UserPromptSubmit, PostToolUse) and the
 *   Notification `notification_type` values permission_prompt | idle_prompt | agent_needs_input | agent_completed are
 *   present in the binary.
 */
export async function claudeLaunch(ctx: AgentLaunchContext): Promise<AgentLaunch> {
  await mkdir(ctx.configDir, { recursive: true });
  const mcpPath = join(ctx.configDir, 'styx-mcp.json');
  const settingsPath = join(ctx.configDir, 'styx-settings.json');
  const hook = `"${styxBin(ctx)}" hook claude`;
  const hookEntry = [{ hooks: [{ type: 'command', command: hook }] }];
  await writeFile(mcpPath, JSON.stringify({ mcpServers: { styx: styxMcpServer(ctx) } }, null, 2));
  await writeFile(
    settingsPath,
    JSON.stringify(
      {
        hooks: {
          SessionStart: hookEntry,
          Stop: hookEntry,
          SessionEnd: hookEntry,
          Notification: hookEntry,
          UserPromptSubmit: hookEntry,
          PostToolUse: [
            { matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: hook }] },
          ],
        },
      },
      null,
      2,
    ),
  );
  const args = ['--mcp-config', mcpPath, '--settings', settingsPath];
  if (ctx.model) args.push('--model', ctx.model);
  // The explicit mode wins; `default` falls back to the session toggle (edits without a prompt = acceptEdits).
  const mode =
    ctx.permissionMode !== 'default' ? ctx.permissionMode : ctx.autoApproveEdits ? 'acceptEdits' : null;
  if (mode !== null) args.push('--permission-mode', mode);
  if (mode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
  if (ctx.effort) args.push('--effort', ctx.effort);
  if (ctx.resumeSessionId) args.push('--resume', ctx.resumeSessionId);
  // Steers deploys through the shims (docs/handoff-discrepancies #56): a system-prompt line, not sandboxing.
  args.push('--append-system-prompt', `${copy.agentPrompt.shims}\n\n${copy.agentPrompt.peers}`);
  const cleanup = () => rm(ctx.configDir, { recursive: true, force: true });
  if (ctx.runner === 'stream') {
    args.push(
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-prompt-tool',
      'stdio',
      // Lets a live `set_permission_mode bypassPermissions` succeed later without starting in bypass.
      '--allow-dangerously-skip-permissions',
      // Text and thinking blocks arrive as deltas (live transcript rows) ahead of the complete `assistant` event.
      '--include-partial-messages',
      // VERIFIED 2026-09-07 on 2.1.263 / claude-fable-5-1: without this the CLI's default display is `omitted` —
      // thinking blocks stream with empty text (signature only). `summarized` = API-side summaries, what Claude Code's
      // own UI shows; also settable live via `set_max_thinking_tokens { thinking_display }`.
      '--thinking-display',
      'summarized',
    );
    // The first message goes down stdin as the first user turn (StreamRunner), never as argv.
    return {
      command: ctx.binary,
      args,
      env: {},
      typeFirstMessage: false,
      stream: { kind: 'stdin' },
      cleanup,
    };
  }
  if (ctx.firstMessage) args.push(ctx.firstMessage);
  return { command: ctx.binary, args, env: {}, typeFirstMessage: false, cleanup };
}

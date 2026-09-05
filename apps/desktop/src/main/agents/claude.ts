import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { styxBin, styxMcpServer, type AgentLaunch, type AgentLaunchContext } from './types';

/**
 * Claude Code: temp `--mcp-config` (styx MCP server) + `--settings` with hooks that forward lifecycle events
 * through `styx hook claude`.
 *
 * VERIFIED 2026-09-04 against `claude` 2.1.199 (`claude --help`, plus `strings` of the native binary for hidden flags):
 * - `--mcp-config <configs...>`, `--settings <file-or-json>`, `--model`, `--permission-mode <mode>`: listed in --help.
 * - `-p/--print`, `--input-format stream-json`, `--output-format stream-json`, `--verbose`,
 *   `--replay-user-messages`, `--include-hook-events`: listed in --help (stream-json input is print-only).
 * - `--permission-prompt-tool`: NOT in --help but present in the binary (hidden flag used by the Agent SDK). The
 *   `stdio` value routes permission prompts as `control_request{subtype:'can_use_tool'}` lines on stdout and expects
 *   a `control_response` on stdin (see stream-runner.ts). Not exercised against a live account (no
 *   `~/.claude/.credentials.json` on the verifying machine), so the runner tolerates its absence: without it, print
 *   mode simply denies un-allowlisted tools.
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
  if (ctx.autoApproveEdits) args.push('--permission-mode', 'acceptEdits');
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

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { styxBin, styxMcpServer, type AgentLaunch, type AgentLaunchContext } from './types';

/**
 * Claude Code: temp `--mcp-config` (styx MCP server) + `--settings` with hooks that forward lifecycle events
 * through `styx hook claude`. Both flags are documented Claude Code CLI flags; hook event names are from the
 * Claude Code hooks reference (Stop, SessionEnd, Notification, UserPromptSubmit, PostToolUse).
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
          Stop: hookEntry,
          SessionEnd: hookEntry,
          Notification: hookEntry,
          UserPromptSubmit: hookEntry,
          PostToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: hook }] }],
        },
      },
      null,
      2,
    ),
  );
  const args = ['--mcp-config', mcpPath, '--settings', settingsPath];
  if (ctx.model) args.push('--model', ctx.model);
  if (ctx.firstMessage) args.push(ctx.firstMessage);
  return {
    command: ctx.binary,
    args,
    env: {},
    typeFirstMessage: false,
    cleanup: () => rm(ctx.configDir, { recursive: true, force: true }),
  };
}

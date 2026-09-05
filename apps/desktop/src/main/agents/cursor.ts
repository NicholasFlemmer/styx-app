import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { excludeLocally } from './git-exclude';
import { styxMcpServer, type AgentLaunch, type AgentLaunchContext } from './types';

/**
 * cursor-agent reads `<worktree>/.cursor/mcp.json` (same shape as Cursor IDE). The file is excluded locally.
 *
 * UNVERIFIED (2026-09-04): `cursor-agent` is not installed on the verifying machine, so none of these flags could be
 * checked with `--help`. They follow Cursor's published CLI docs: `--print` (`-p`) headless mode,
 * `--output-format stream-json`, `--model <name>`, `--resume <chat-id>`, positional prompt. The stream runner is
 * only chosen when DetectService saw both `stream-json` and `--print` in the CLI's own `--help`
 * (`capabilities.streamJson && capabilities.printMode`); otherwise the session falls back to `pty`. cursor-agent has
 * no stream-json *input* mode, so each user turn is a fresh process with `--resume <chatId>` (`stream.kind = 'argv'`).
 */
export async function cursorLaunch(ctx: AgentLaunchContext): Promise<AgentLaunch> {
  const dir = join(ctx.worktreePath, '.cursor');
  const file = join(dir, 'mcp.json');
  await mkdir(dir, { recursive: true });
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    existing = {};
  }
  const mcpServers = {
    ...((existing['mcpServers'] as Record<string, unknown> | undefined) ?? {}),
    styx: styxMcpServer(ctx),
  };
  await writeFile(file, JSON.stringify({ ...existing, mcpServers }, null, 2));
  await excludeLocally(ctx.worktreePath, '.cursor/mcp.json');
  const args: string[] = [];
  if (ctx.model) args.push('--model', ctx.model);
  if (ctx.runner === 'stream') {
    args.push('--print', '--output-format', 'stream-json');
    return {
      command: ctx.binary,
      args,
      env: {},
      typeFirstMessage: false,
      stream: { kind: 'argv', resumeFlag: '--resume' },
      cleanup: async () => undefined,
    };
  }
  if (ctx.firstMessage) args.push(ctx.firstMessage);
  return { command: ctx.binary, args, env: {}, typeFirstMessage: false, cleanup: async () => undefined };
}

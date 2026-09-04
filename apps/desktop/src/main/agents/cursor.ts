import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { excludeLocally } from './git-exclude';
import { styxMcpServer, type AgentLaunch, type AgentLaunchContext } from './types';

/**
 * cursor-agent reads `<worktree>/.cursor/mcp.json` (same shape as Cursor IDE). The file is excluded locally.
 * UNVERIFIED FLAGS: `--model <name>` and a positional prompt; confirm in the Phase 8 spike.
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
  const mcpServers = { ...((existing['mcpServers'] as Record<string, unknown> | undefined) ?? {}), styx: styxMcpServer(ctx) };
  await writeFile(file, JSON.stringify({ ...existing, mcpServers }, null, 2));
  await excludeLocally(ctx.worktreePath, '.cursor/mcp.json');
  const args: string[] = [];
  if (ctx.model) args.push('--model', ctx.model);
  if (ctx.firstMessage) args.push(ctx.firstMessage);
  return { command: ctx.binary, args, env: {}, typeFirstMessage: false, cleanup: async () => undefined };
}

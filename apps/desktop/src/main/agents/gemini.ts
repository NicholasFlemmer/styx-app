import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { excludeLocally } from './git-exclude';
import { styxMcpServer, type AgentLaunch, type AgentLaunchContext } from './types';

/**
 * Gemini CLI reads `<worktree>/.gemini/settings.json`; the styx MCP server is merged in and the file is kept out
 * of the repo via `.git/info/exclude`.
 *
 * UNVERIFIED (2026-09-04): `gemini` is not installed on the verifying machine; `-m <model>` and
 * `-i/--prompt-interactive <prompt>` follow the Gemini CLI docs and were not checked with `--help`. Gemini stays on
 * the `pty` runner (ADR-0010): its headless mode is one-shot (`-p`) with no stream input, so idle/working comes from
 * pty output + the 3 s quiet timer.
 */
export async function geminiLaunch(ctx: AgentLaunchContext): Promise<AgentLaunch> {
  const dir = join(ctx.worktreePath, '.gemini');
  const file = join(dir, 'settings.json');
  await mkdir(dir, { recursive: true });
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    existing = {};
  }
  const mcpServers = { ...((existing['mcpServers'] as Record<string, unknown> | undefined) ?? {}), styx: styxMcpServer(ctx) };
  await writeFile(file, JSON.stringify({ ...existing, mcpServers }, null, 2));
  await excludeLocally(ctx.worktreePath, '.gemini/settings.json');
  const args: string[] = [];
  if (ctx.model) args.push('-m', ctx.model);
  if (ctx.firstMessage) args.push('-i', ctx.firstMessage);
  return { command: ctx.binary, args, env: {}, typeFirstMessage: false, cleanup: async () => undefined };
}

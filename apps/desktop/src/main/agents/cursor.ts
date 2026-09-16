import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { excludeLocally } from './git-exclude';
import { writeWorktreeMcpConfig, type AgentLaunch, type AgentLaunchContext } from './types';

const io = {
  mkdir: (d: string) => mkdir(d, { recursive: true }).then(() => undefined),
  read: (f: string) => readFile(f, 'utf8'),
  write: (f: string, text: string) => writeFile(f, text),
  remove: (f: string) => rm(f, { force: true }),
};

/**
 * Cursor's CLI (`agent`, older installs `cursor-agent`) has three launches (ADR-0017):
 *
 * - **ACP** (`agent [--model m] acp`, the `stream` runner) when DetectService saw an `acp` subcommand in `--help`:
 *   JSON-RPC over pipes with approvals, the styx MCP server handed over in `session/new.mcpServers`, nothing
 *   written into the worktree. Global flags go before the subcommand, as Cursor's docs show (`agent -k acp`).
 * - **print fallback** (`--print --output-format stream-json`, the `argv` stream runner) when the CLI advertises
 *   stream-json and `--print` but no ACP: one process per turn with `--resume <chatId>`, no approvals.
 * - **pty fallback** otherwise: the TUI in xterm.
 *
 * Both fallbacks read `<worktree>/.cursor/mcp.json` (same shape as Cursor IDE): the styx server is merged in,
 * the file is excluded locally, carries no env block (cursor-agent inherits the session env, so `STYX_TOKEN` never
 * lands in the worktree) and is restored or removed by `cleanup`.
 *
 * UNVERIFIED (2026-09-16): the CLI is not installed on the verifying machine, so none of these flags could be
 * checked with `--help`; they follow Cursor's published CLI docs (`agent acp`, `--print`, `--output-format
 * stream-json`, `--model <name>`, `--resume <chat-id>`, positional prompt).
 */
export async function cursorLaunch(ctx: AgentLaunchContext): Promise<AgentLaunch> {
  const args: string[] = [];
  if (ctx.model) args.push('--model', ctx.model);
  if (ctx.runner === 'stream' && ctx.capabilities['acp'] === true) {
    args.push('acp');
    return {
      command: ctx.binary,
      args,
      env: {},
      typeFirstMessage: false,
      stream: { kind: 'acp' },
      cleanup: async () => undefined,
    };
  }
  const dir = join(ctx.worktreePath, '.cursor');
  const file = join(dir, 'mcp.json');
  const written = await writeWorktreeMcpConfig(file, ctx, io, dir);
  await excludeLocally(ctx.worktreePath, '.cursor/mcp.json');
  const cleanup = () => written.restore();
  if (ctx.runner === 'stream') {
    args.push('--print', '--output-format', 'stream-json');
    return {
      command: ctx.binary,
      args,
      env: {},
      typeFirstMessage: false,
      stream: { kind: 'argv', resumeFlag: '--resume' },
      cleanup,
    };
  }
  if (ctx.firstMessage) args.push(ctx.firstMessage);
  return { command: ctx.binary, args, env: {}, typeFirstMessage: false, cleanup };
}

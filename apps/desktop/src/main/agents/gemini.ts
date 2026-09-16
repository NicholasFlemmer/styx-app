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
 * Gemini CLI has two launches (ADR-0017):
 *
 * - **ACP** (`gemini --acp`, the `stream` runner) when DetectService saw `--acp` in the CLI's `--help`: JSON-RPC
 *   over pipes, the styx MCP server handed over in `session/new.mcpServers`, so nothing is written into the
 *   worktree. `-m <model>` is the launch model; live switches go through the protocol.
 * - **pty fallback** for older builds: the TUI in xterm, the styx MCP server merged into
 *   `<worktree>/.gemini/settings.json` (kept out of the repo via `.git/info/exclude`, no env block so `STYX_TOKEN`
 *   never touches the worktree; `cleanup` restores the file). `-i/--prompt-interactive` carries the first message.
 *
 * UNVERIFIED (2026-09-16): `gemini` is not installed on the verifying machine; `--acp`, `-m` and `-i` follow the
 * Gemini CLI docs (0.39) and were not checked with `--help`.
 */
export async function geminiLaunch(ctx: AgentLaunchContext): Promise<AgentLaunch> {
  const args: string[] = [];
  if (ctx.runner === 'stream' && ctx.capabilities['acp'] === true) {
    args.push('--acp');
    if (ctx.model) args.push('-m', ctx.model);
    return {
      command: ctx.binary,
      args,
      env: {},
      typeFirstMessage: false,
      stream: { kind: 'acp' },
      cleanup: async () => undefined,
    };
  }
  const dir = join(ctx.worktreePath, '.gemini');
  const file = join(dir, 'settings.json');
  const written = await writeWorktreeMcpConfig(file, ctx, io, dir);
  await excludeLocally(ctx.worktreePath, '.gemini/settings.json');
  if (ctx.model) args.push('-m', ctx.model);
  if (ctx.firstMessage) args.push('-i', ctx.firstMessage);
  return { command: ctx.binary, args, env: {}, typeFirstMessage: false, cleanup: () => written.restore() };
}

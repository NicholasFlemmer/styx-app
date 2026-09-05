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
 * Gemini CLI reads `<worktree>/.gemini/settings.json`; the styx MCP server is merged in and the file is kept out
 * of the repo via `.git/info/exclude`. The entry carries no env block — Gemini spawns MCP servers with its own
 * environment, which is the session env (`STYX_TOKEN` never touches the worktree) — and `cleanup` restores the file
 * to what it was before the session (or deletes it).
 *
 * UNVERIFIED (2026-09-04): `gemini` is not installed on the verifying machine; `-m <model>` and
 * `-i/--prompt-interactive <prompt>` follow the Gemini CLI docs and were not checked with `--help`. Gemini stays on
 * the `pty` runner (ADR-0010): its headless mode is one-shot (`-p`) with no stream input, so idle/working comes from
 * pty output + the 3 s quiet timer.
 */
export async function geminiLaunch(ctx: AgentLaunchContext): Promise<AgentLaunch> {
  const dir = join(ctx.worktreePath, '.gemini');
  const file = join(dir, 'settings.json');
  const written = await writeWorktreeMcpConfig(file, ctx, io, dir);
  await excludeLocally(ctx.worktreePath, '.gemini/settings.json');
  const args: string[] = [];
  if (ctx.model) args.push('-m', ctx.model);
  if (ctx.firstMessage) args.push('-i', ctx.firstMessage);
  return { command: ctx.binary, args, env: {}, typeFirstMessage: false, cleanup: () => written.restore() };
}

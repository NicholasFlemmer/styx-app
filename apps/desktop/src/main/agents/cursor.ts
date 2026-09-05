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
 * cursor-agent reads `<worktree>/.cursor/mcp.json` (same shape as Cursor IDE). The file is excluded locally, carries
 * no env block (cursor-agent inherits the session env, so `STYX_TOKEN` never lands in the worktree) and is restored
 * or removed by `cleanup`.
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
  const written = await writeWorktreeMcpConfig(file, ctx, io, dir);
  await excludeLocally(ctx.worktreePath, '.cursor/mcp.json');
  const args: string[] = [];
  if (ctx.model) args.push('--model', ctx.model);
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

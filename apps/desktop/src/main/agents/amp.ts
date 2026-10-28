import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { excludeLocally } from './git-exclude';
import { ExecaGitRunner } from '../services/git';
import { styxMcpServerInherit, type AgentLaunch, type AgentLaunchContext } from './types';

/**
 * Amp's stream-json has no documented interactive permission round trip. Keep approvals in its TUI.
 * Neo defaults to allowing tools, so pin an explicit catch-all rule in the worktree's settings (which override
 * user settings). settings.json takes precedence over settings.jsonc. Never persist the broker token.
 * VERIFIED: Amp 0.0.1792670445-ge8d5b3 --help and offline `permissions test --json --workspace` (2026-10-22).
 * Bypass's positive flag is accepted by that CLI and emitted by official @ampcode/sdk; live inference/bypass
 * and provider authentication remain unverified. No model calls are made by tests or verification.
 */
export async function ampLaunch(ctx: AgentLaunchContext): Promise<AgentLaunch> {
  const dir = join(ctx.worktreePath, '.amp');
  const file = join(dir, 'settings.json');
  // Worktree policy must not escape through a symlink/junction or become a versioned change at Land/Publish.
  const checkPaths = async (): Promise<void> => {
    for (const path of [dir, file]) {
      const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (stat?.isSymbolicLink()) throw new Error('Amp settings must not use symbolic links or junctions');
    }
  };
  await checkPaths();
  const git = new ExecaGitRunner({ loginPath: async () => ctx.env['PATH'] ?? process.env['PATH'] ?? '' });
  const tracked = await git.run(['ls-files', '--cached', '--', '.amp/settings.json'], ctx.worktreePath, {
    env: ctx.env,
  });
  if (tracked.stdout.trim() !== '')
    throw new Error('Amp settings.json is tracked by git; Styx cannot safely replace its permission rules');
  let previous: string | null = null;
  try {
    previous = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Refuse an unparseable existing file rather than discard settings or silently leave a permissive rule active.
  let settings: Record<string, unknown> = {};
  try {
    if (previous !== null)
      settings = z.record(z.string(), z.unknown()).parse(JSON.parse(previous) as unknown);
  } catch {
    // JSON parse errors can quote configuration values. Only this fixed error crosses the launch boundary.
    throw new Error('Amp settings.json must contain a valid JSON object');
  }
  const bypass = ctx.permissionMode === 'bypassPermissions';
  const deny = ctx.permissionMode === 'plan' || ctx.permissionMode === 'dontAsk';
  await mkdir(dir, { recursive: true });
  await mkdir(ctx.configDir, { recursive: true });
  const mcpFile = join(ctx.configDir, 'mcp.json');
  const temporary = join(dir, `.styx-settings-${randomUUID()}.tmp`);
  try {
    await writeFile(mcpFile, JSON.stringify({ styx: styxMcpServerInherit(ctx) }));
    await excludeLocally(ctx.worktreePath, '.amp/settings.json');
    await excludeLocally(ctx.worktreePath, '.amp/.styx-settings-*.tmp');
    await writeFile(
      temporary,
      JSON.stringify(
        {
          ...settings,
          'amp.dangerouslyAllowAll': false,
          'amp.permissions': [{ tool: '*', action: deny ? 'reject' : 'ask' }],
        },
        null,
        2,
      ),
      { flag: 'wx' },
    );
    // Same-directory rename: a failed write cannot truncate the original settings.
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    await rm(ctx.configDir, { recursive: true, force: true });
    throw error;
  }
  const args = ['--executor', 'local', '--mcp-config', mcpFile];
  // Process-only bypass, also used by the official @ampcode/sdk. A crash must never leave allow-all on disk.
  if (bypass) args.push('--dangerously-allow-all');
  // Amp selects models through named modes, not a raw provider model id.
  if (ctx.model) args.push('--mode', ctx.model);
  return {
    command: ctx.binary,
    args,
    env: {},
    typeFirstMessage: true,
    bracketedPaste: true,
    cleanup: async () => {
      try {
        await checkPaths();
        if (previous === null) await rm(file, { force: true });
        else await writeFile(file, previous);
      } finally {
        await rm(ctx.configDir, { recursive: true, force: true });
      }
    },
  };
}

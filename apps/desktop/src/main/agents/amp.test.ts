import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAgentLaunch } from './index';
import type { AgentLaunchContext } from './types';
import { ExecaGitRunner } from '../services/git';
import { writeShims } from '../services/shim-service';

const context = async (): Promise<AgentLaunchContext> => {
  const root = await mkdtemp(join(tmpdir(), 'styx-amp-'));
  const worktreePath = join(root, 'worktree');
  await mkdir(join(worktreePath, '.amp'), { recursive: true });
  await new ExecaGitRunner().run(['init', '--quiet'], worktreePath);
  return {
    agent: 'amp',
    binary: '/opt/tools with spaces/amp',
    sessionId: 's',
    worktreePath,
    projectPath: root,
    firstMessage: 'hello\nworld',
    model: null,
    runner: 'pty',
    capabilities: { streamJson: true },
    autoApproveEdits: false,
    permissionMode: 'default',
    effort: null,
    resumeSessionId: null,
    configDir: join(root, 'private'),
    shimDir: '/styx shims',
    platform: 'darwin',
    env: { STYX_TOKEN: 'test-session-token', STYX_BROKER: '/broker', STYX_SESSION_ID: 's' },
  };
};

describe('Amp terminal launch', () => {
  it('launches when its Git inspection uses the session shim', async () => {
    const ctx = await context();
    const shims = writeShims(ctx.projectPath, process.platform);
    const cli = join(ctx.projectPath, 'session-cli.cjs');
    await writeFile(cli, "if (process.env.STYX_SESSION_ID !== 's') process.exit(73);\n");
    ctx.env = {
      ...ctx.env,
      PATH: `${shims.dir}${delimiter}${process.env['PATH'] ?? ''}`,
      STYX_SHIM_DIR: shims.dir,
      STYX_EXE: process.execPath,
      STYX_CLI: cli,
    };
    const launch = await buildAgentLaunch(ctx);
    expect(launch.command).toBe(ctx.binary);
    expect(existsSync(join(ctx.worktreePath, '.amp', 'settings.json'))).toBe(true);
    await launch.cleanup();
  });
  it.each([
    ['default', 'ask'],
    ['acceptEdits', 'ask'],
    ['auto', 'ask'],
    ['plan', 'reject'],
    ['dontAsk', 'reject'],
    ['bypassPermissions', 'ask'],
  ] as const)(
    '%s pins %s ahead of permissive workspace rules and restores the file verbatim',
    async (permissionMode, action) => {
      const ctx = { ...(await context()), permissionMode, autoApproveEdits: true };
      const file = join(ctx.worktreePath, '.amp', 'settings.json');
      const original =
        '{ "amp.dangerouslyAllowAll": true, "amp.permissions": [{"tool":"*","action":"allow"}], "amp.showCosts": false }\n';
      await writeFile(file, original);
      const launch = await buildAgentLaunch(ctx);
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
        'amp.dangerouslyAllowAll': false,
        'amp.permissions': [{ tool: '*', action }],
        'amp.showCosts': false,
      });
      expect(launch).toMatchObject({
        command: ctx.binary,
        typeFirstMessage: true,
        bracketedPaste: true,
        env: {},
      });
      expect(launch.stream).toBeUndefined();
      expect(launch.args).toEqual([
        '--executor',
        'local',
        '--mcp-config',
        join(ctx.configDir, 'mcp.json'),
        ...(permissionMode === 'bypassPermissions' ? ['--dangerously-allow-all'] : []),
      ]);
      const mcp = await readFile(join(ctx.configDir, 'mcp.json'), 'utf8');
      expect(JSON.parse(mcp)).toEqual({ styx: { command: '/styx shims/styx', args: ['mcp'] } });
      expect(mcp + (await readFile(file, 'utf8')) + JSON.stringify(launch)).not.toContain(
        'test-session-token',
      );
      await launch.cleanup();
      expect(await readFile(file, 'utf8')).toBe(original);
      expect(existsSync(ctx.configDir)).toBe(false);
    },
  );

  it('shadows an existing JSONC file without modifying it; removes only the generated JSON on cleanup', async () => {
    const ctx = {
      ...(await context()),
      model: 'high',
      platform: 'win32' as const,
      shimDir: 'C:\\Styx shims',
    };
    const jsonc = join(ctx.worktreePath, '.amp', 'settings.jsonc');
    const original = '// keep my comments\n{ "amp.dangerouslyAllowAll": true }';
    await writeFile(jsonc, original);
    const launch = await buildAgentLaunch(ctx);
    expect(launch.args.slice(-2)).toEqual(['--mode', 'high']);
    expect(JSON.parse(await readFile(join(ctx.configDir, 'mcp.json'), 'utf8'))).toEqual({
      styx: { command: 'cmd.exe', args: ['/d', '/c', 'C:\\Styx shims\\styx.cmd', 'mcp'] },
    });
    expect(await readFile(jsonc, 'utf8')).toBe(original);
    await launch.cleanup();
    expect(existsSync(join(ctx.worktreePath, '.amp', 'settings.json'))).toBe(false);
    expect(await readFile(jsonc, 'utf8')).toBe(original);
  });

  it.each(['not json', '[]', 'null'])(
    'refuses invalid settings %s without changing them',
    async (original) => {
      const ctx = await context();
      const file = join(ctx.worktreePath, '.amp', 'settings.json');
      await writeFile(file, original);
      await expect(buildAgentLaunch(ctx)).rejects.toThrow();
      expect(await readFile(file, 'utf8')).toBe(original);
      expect(existsSync(ctx.configDir)).toBe(false);
    },
  );

  it('refuses tracked policy settings without modifying them or staging a policy change', async () => {
    const ctx = await context();
    const file = join(ctx.worktreePath, '.amp', 'settings.json');
    const original = '{"amp.dangerouslyAllowAll":true}';
    await writeFile(file, original);
    const git = new ExecaGitRunner();
    await git.run(['add', '--', '.amp/settings.json'], ctx.worktreePath);
    await expect(buildAgentLaunch(ctx)).rejects.toThrow(/tracked by git/);
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(existsSync(ctx.configDir)).toBe(false);
    expect((await git.run(['diff', '--', '.amp/settings.json'], ctx.worktreePath)).stdout).toBe('');
  });

  it('refuses a .amp directory symlink or Windows junction without writing to its target', async () => {
    const ctx = await context();
    const outside = await mkdtemp(join(tmpdir(), 'styx-amp-outside-'));
    const file = join(outside, 'settings.json');
    await writeFile(file, '{}');
    await rmdir(join(ctx.worktreePath, '.amp'));
    await symlink(outside, join(ctx.worktreePath, '.amp'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(buildAgentLaunch(ctx)).rejects.toThrow(/symbolic links or junctions/);
    expect(await readFile(file, 'utf8')).toBe('{}');
    expect(existsSync(ctx.configDir)).toBe(false);
  });

  it('refuses a link introduced after launch during cleanup and still removes private configuration', async () => {
    const ctx = await context();
    await writeFile(join(ctx.worktreePath, '.amp', 'settings.json'), '{"amp.showCosts":false}');
    const launch = await buildAgentLaunch(ctx);
    const outside = await mkdtemp(join(tmpdir(), 'styx-amp-cleanup-'));
    const file = join(outside, 'settings.json');
    await writeFile(file, '{"keep":"outside"}');
    await rename(join(ctx.worktreePath, '.amp'), join(ctx.worktreePath, '.amp-original'));
    await symlink(outside, join(ctx.worktreePath, '.amp'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(launch.cleanup()).rejects.toThrow(/symbolic links or junctions/);
    expect(await readFile(file, 'utf8')).toBe('{"keep":"outside"}');
    expect(existsSync(ctx.configDir)).toBe(false);
  });
});

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { claudeLaunch } from './claude';
import { cursorLaunch } from './cursor';
import { geminiLaunch } from './gemini';
import type { AgentLaunchContext } from './types';

const ctx = (agent: 'gemini' | 'cursor' | 'claude', worktreePath: string): AgentLaunchContext => ({
  agent,
  binary: agent,
  sessionId: 'sess-1',
  worktreePath,
  firstMessage: null,
  model: null,
  runner: 'pty',
  autoApproveEdits: false,
  permissionMode: 'default',
  effort: null,
  resumeSessionId: null,
  configDir: join(worktreePath, '..', 'cfg'),
  shimDir: '/shims',
  platform: 'darwin',
  env: { STYX_SESSION_ID: 'sess-1', STYX_BROKER: '/tmp/b.sock', STYX_TOKEN: 'tok-super-secret' },
});

describe('worktree MCP config (L5)', () => {
  it.each([
    ['gemini', '.gemini/settings.json', geminiLaunch] as const,
    ['cursor', '.cursor/mcp.json', cursorLaunch] as const,
  ])('%s: writes no token into the worktree and removes the file on cleanup', async (agent, rel, launch) => {
    const wt = mkdtempSync(join(tmpdir(), 'styx-wt-'));
    const file = join(wt, rel);
    const l = await launch(ctx(agent, wt));
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('tok-super-secret');
    expect(text).not.toContain('STYX_TOKEN');
    const cfg = JSON.parse(text) as { mcpServers: { styx: Record<string, unknown> } };
    expect(cfg.mcpServers.styx).toEqual({ command: '/shims/styx', args: ['mcp'] });
    expect(l.env).toEqual({});
    await l.cleanup();
    expect(existsSync(file)).toBe(false);
  });

  it('gemini: merges into an existing settings file and restores it verbatim on cleanup', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'styx-wt-'));
    const dir = join(wt, '.gemini');
    await mkdir(dir, { recursive: true });
    const original = JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } }, null, 4);
    await writeFile(join(dir, 'settings.json'), original);
    const l = await geminiLaunch(ctx('gemini', wt));
    const merged = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as {
      theme: string;
      mcpServers: Record<string, unknown>;
    };
    expect(merged.theme).toBe('dark');
    expect(Object.keys(merged.mcpServers).sort()).toEqual(['other', 'styx']);
    await l.cleanup();
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe(original);
  });
});

describe('claude launch flags (verified against claude 2.1.263)', () => {
  const launch = async (over: Partial<AgentLaunchContext>) => {
    const wt = mkdtempSync(join(tmpdir(), 'styx-wt-'));
    const l = await claudeLaunch({ ...ctx('claude', wt), ...over });
    await l.cleanup();
    return l.args;
  };
  const pair = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];

  it.each([
    ['default', false, null],
    ['default', true, 'acceptEdits'],
    ['acceptEdits', false, 'acceptEdits'],
    ['plan', true, 'plan'],
    ['bypassPermissions', false, 'bypassPermissions'],
    ['dontAsk', true, 'dontAsk'],
    ['auto', false, 'auto'],
  ] as const)(
    'permissionMode=%s autoApproveEdits=%s → --permission-mode %s (explicit mode wins over the toggle)',
    async (permissionMode, autoApproveEdits, expected) => {
      const args = await launch({ permissionMode, autoApproveEdits });
      if (expected === null) expect(args).not.toContain('--permission-mode');
      else expect(pair(args, '--permission-mode')).toBe(expected);
      expect(args.includes('--dangerously-skip-permissions')).toBe(expected === 'bypassPermissions');
    },
  );

  it.each([
    ['stream', true],
    ['pty', false],
  ] as const)(
    '%s launch: --allow-dangerously-skip-permissions and --include-partial-messages present = %s',
    async (runner, present) => {
      const args = await launch({ runner });
      expect(args.includes('--allow-dangerously-skip-permissions')).toBe(present);
      expect(args.includes('--include-partial-messages')).toBe(present);
      expect(args.includes('-p')).toBe(runner === 'stream');
    },
  );

  it.each([
    [null, null, [] as string[]],
    ['high', null, ['--effort', 'high']],
    [null, 'sess-abc', ['--resume', 'sess-abc']],
    ['max', 'sess-abc', ['--effort', 'max', '--resume', 'sess-abc']],
  ] as const)('effort=%s resume=%s → %j', async (effort, resumeSessionId, expected) => {
    const args = await launch({ effort, resumeSessionId, model: 'opus' });
    const tail = args.slice(args.indexOf('--model'), args.indexOf('--model') + 2 + expected.length);
    expect(tail).toEqual(['--model', 'opus', ...expected]);
    if (effort === null) expect(args).not.toContain('--effort');
    if (resumeSessionId === null) expect(args).not.toContain('--resume');
  });

  it('pty launch keeps the first message as the last argument; stream launch never puts it in argv', async () => {
    expect((await launch({ runner: 'pty', firstMessage: 'Fix it' })).at(-1)).toBe('Fix it');
    expect(await launch({ runner: 'stream', firstMessage: 'Fix it' })).not.toContain('Fix it');
  });
});

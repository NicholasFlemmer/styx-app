import { copy } from '@styx/core';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { claudeLaunch } from './claude';
import { codexLaunch, codexTrustKey } from './codex';
import { cursorLaunch } from './cursor';
import { geminiLaunch } from './gemini';
import { agentPreamble, PREAMBLE_AGENTS, type AgentLaunchContext } from './types';

const ctx = (agent: 'gemini' | 'cursor' | 'claude', worktreePath: string): AgentLaunchContext => ({
  agent,
  binary: agent,
  capabilities: {},
  sessionId: 'sess-1',
  worktreePath,
  projectPath: worktreePath,
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

describe('codex launch flags (verified against codex 0.154.0)', () => {
  it('registers the styx MCP server with forwarded env names, the notify hook, and trusts both the worktree and the project root', async () => {
    const base = ctx('gemini', '/Users/nic/.styx/worktrees/STYX/agent-codex-1');
    const l = await codexLaunch({
      ...base,
      agent: 'codex',
      binary: '/opt/codex',
      projectPath: '/Users/nic/STYX',
      firstMessage: 'fix the flaky test',
      model: 'gpt-6',
    });
    expect(l.command).toBe('/opt/codex');
    expect(l.typeFirstMessage).toBe(false);
    const joined = l.args.join(' ');
    expect(l.args).toContain('mcp_servers.styx.command="/shims/styx"');
    expect(l.args).toContain('mcp_servers.styx.args=["mcp"]');
    expect(joined).toContain('mcp_servers.styx.env_vars=["STYX_SESSION_ID","STYX_BROKER","STYX_TOKEN"');
    expect(l.args).toContain('notify=["/shims/styx","hook","codex"]');
    expect(l.args).toContain(
      'projects."/Users/nic/.styx/worktrees/STYX/agent-codex-1".trust_level="trusted"',
    );
    expect(l.args).toContain('projects."/Users/nic/STYX".trust_level="trusted"');
    // The token is forwarded by name, never spelled out on the command line.
    expect(joined).not.toContain('tok-super-secret');
    expect(l.args.slice(-3)).toEqual(['-m', 'gpt-6', 'fix the flaky test']);
  });

  it('marks the directory once when the worktree is the project root, and escapes quotes and backslashes in the key', async () => {
    const l = await codexLaunch({
      ...ctx('gemini', '/Users/nic/STYX'),
      agent: 'codex',
      projectPath: '/Users/nic/STYX',
    });
    expect(l.args.filter((a) => a.startsWith('projects.'))).toHaveLength(1);
    expect(codexTrustKey('C:\\dev\\my "app"')).toBe('projects."C:\\\\dev\\\\my \\"app\\"".trust_level');
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
      const prompt = args.indexOf('--append-system-prompt');
      // Shim discipline plus the standing framing for peer messages.
      expect(prompt >= 0 && (args[prompt + 1] ?? '').startsWith(copy.agentPrompt.shims)).toBe(true);
      expect(args[prompt + 1]).toContain(copy.agentPrompt.peers);
      const display = args.indexOf('--thinking-display');
      expect(display >= 0 && args[display + 1] === 'summarized').toBe(present);
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

describe('agentPreamble (ADR-0025): CLIs without a system-prompt flag get the same lines ahead of their first turn', () => {
  it('leads with the Styx line, then shims, peers, the lane and the other lanes; alone on main it is shims and peers', () => {
    const full = agentPreamble({
      branch: 'fix/checkout',
      base: 'main',
      others: 'Other lanes in this project right now:\n- Codex on test/flaky',
    });
    expect(full.split('\n\n')).toEqual([
      copy.agentPrompt.preamble,
      copy.agentPrompt.shims,
      copy.agentPrompt.peers,
      'Your worktree is the branch fix/checkout, cut from main. Styx keeps it current: it fetches before a session starts, merges main in before Publish, and shows how far behind the lane is. Do not rebase, merge or switch branches yourself. If a merge conflict appears in the tree, resolve it in place and tell the user.',
      'Other lanes in this project right now:\n- Codex on test/flaky',
    ]);
    expect(agentPreamble(undefined).split('\n\n')).toEqual([
      copy.agentPrompt.preamble,
      copy.agentPrompt.shims,
      copy.agentPrompt.peers,
    ]);
    expect(agentPreamble({ branch: 'x', base: 'main', others: '' }).split('\n\n')).toHaveLength(4);
    expect(PREAMBLE_AGENTS).toEqual(['codex', 'gemini', 'cursor']);
  });
});

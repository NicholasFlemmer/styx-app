import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { geminiLaunch } from './gemini';
import type { AgentLaunchContext } from './types';

const ctx = (over: Partial<AgentLaunchContext> = {}): AgentLaunchContext => {
  const worktreePath = mkdtempSync(join(tmpdir(), 'styx-wt-'));
  return {
    agent: 'gemini',
    binary: '/opt/homebrew/bin/gemini',
    capabilities: {},
    sessionId: 'sess-1',
    worktreePath,
    projectPath: worktreePath,
    firstMessage: 'hi',
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
    ...over,
  };
};

/** Gemini CLI launches (ADR-0017): ACP over pipes when the CLI advertises `--acp`, the TUI in a pty otherwise. */
describe('geminiLaunch', () => {
  it('ACP: `--acp` (+ `-m <model>`), stream kind acp, no config file in the worktree, first message stays out of argv', async () => {
    const c = ctx({ runner: 'stream', capabilities: { acp: true }, model: 'gemini-2.5-pro' });
    const l = await geminiLaunch(c);
    expect(l.command).toBe('/opt/homebrew/bin/gemini');
    expect(l.args).toEqual(['--acp', '-m', 'gemini-2.5-pro']);
    expect(l.stream).toEqual({ kind: 'acp' });
    expect(l.typeFirstMessage).toBe(false);
    expect(l.env).toEqual({});
    // The styx MCP server travels in session/new; the worktree is untouched.
    expect(existsSync(join(c.worktreePath, '.gemini'))).toBe(false);
    await l.cleanup();
    expect(existsSync(join(c.worktreePath, '.gemini'))).toBe(false);
  });

  it('ACP without a model passes only `--acp`', async () => {
    const l = await geminiLaunch(ctx({ runner: 'stream', capabilities: { acp: true } }));
    expect(l.args).toEqual(['--acp']);
  });

  it.each([
    ['pty runner even with the flag', 'pty', { acp: true }],
    ['stream runner without the flag', 'stream', {}],
  ] as const)(
    '%s: falls back to the TUI with `-m`, `-i <first message>` and the settings.json MCP entry',
    async (_name, runner, capabilities) => {
      const c = ctx({ runner, capabilities, model: 'gemini-2.5-flash' });
      const l = await geminiLaunch(c);
      expect(l.stream).toBeUndefined();
      expect(l.args).toEqual(['-m', 'gemini-2.5-flash', '-i', 'hi']);
      const file = join(c.worktreePath, '.gemini', 'settings.json');
      const text = readFileSync(file, 'utf8');
      expect(text).not.toContain('tok-super-secret');
      expect(JSON.parse(text)).toEqual({ mcpServers: { styx: { command: '/shims/styx', args: ['mcp'] } } });
      await l.cleanup();
      expect(existsSync(file)).toBe(false);
    },
  );
});

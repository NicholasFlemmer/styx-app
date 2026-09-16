import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cursorLaunch } from './cursor';
import type { AgentLaunchContext } from './types';

const ctx = (over: Partial<AgentLaunchContext> = {}): AgentLaunchContext => {
  const worktreePath = mkdtempSync(join(tmpdir(), 'styx-wt-'));
  return {
    agent: 'cursor',
    binary: '/opt/homebrew/bin/agent',
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

const mcpFile = (c: AgentLaunchContext) => join(c.worktreePath, '.cursor', 'mcp.json');

/** Cursor CLI launches (ADR-0017): ACP when advertised, else the print-mode stream runner, else the TUI. */
describe('cursorLaunch', () => {
  it('ACP: global `--model` before the `acp` subcommand, stream kind acp, nothing written into the worktree', async () => {
    const c = ctx({
      runner: 'stream',
      capabilities: { acp: true, streamJson: true, printMode: true },
      model: 'sonnet-4',
    });
    const l = await cursorLaunch(c);
    expect(l.command).toBe('/opt/homebrew/bin/agent');
    expect(l.args).toEqual(['--model', 'sonnet-4', 'acp']);
    expect(l.stream).toEqual({ kind: 'acp' });
    expect(l.typeFirstMessage).toBe(false);
    expect(l.env).toEqual({});
    expect(existsSync(join(c.worktreePath, '.cursor'))).toBe(false);
    await l.cleanup();
    expect(existsSync(join(c.worktreePath, '.cursor'))).toBe(false);
  });

  it('ACP without a model is just `acp`', async () => {
    const l = await cursorLaunch(ctx({ runner: 'stream', capabilities: { acp: true } }));
    expect(l.args).toEqual(['acp']);
  });

  it('print fallback: stream runner without ACP keeps `--print --output-format stream-json` (argv, --resume) and mcp.json', async () => {
    const c = ctx({ runner: 'stream', capabilities: { streamJson: true, printMode: true }, model: 'auto' });
    const l = await cursorLaunch(c);
    expect(l.args).toEqual(['--model', 'auto', '--print', '--output-format', 'stream-json']);
    expect(l.stream).toEqual({ kind: 'argv', resumeFlag: '--resume' });
    const text = readFileSync(mcpFile(c), 'utf8');
    expect(text).not.toContain('tok-super-secret');
    expect(JSON.parse(text)).toEqual({ mcpServers: { styx: { command: '/shims/styx', args: ['mcp'] } } });
    await l.cleanup();
    expect(existsSync(mcpFile(c))).toBe(false);
  });

  it('pty fallback: the TUI with the first message as the last argument, ACP flag or not', async () => {
    const c = ctx({ runner: 'pty', capabilities: { acp: true } });
    const l = await cursorLaunch(c);
    expect(l.stream).toBeUndefined();
    expect(l.args).toEqual(['hi']);
    expect(existsSync(mcpFile(c))).toBe(true);
    await l.cleanup();
    expect(existsSync(mcpFile(c))).toBe(false);
  });
});

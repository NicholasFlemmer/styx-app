import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { cursorLaunch } from './cursor';
import { geminiLaunch } from './gemini';
import type { AgentLaunchContext } from './types';

const ctx = (agent: 'gemini' | 'cursor', worktreePath: string): AgentLaunchContext => ({
  agent,
  binary: agent,
  sessionId: 'sess-1',
  worktreePath,
  firstMessage: null,
  model: null,
  runner: 'pty',
  autoApproveEdits: false,
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

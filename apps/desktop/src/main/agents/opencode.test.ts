import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { permissionModeSchema } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { OPENCODE_MODES, opencodeConfig, opencodeLaunch, type OpencodeHost } from './opencode';
import type { AgentLaunchContext } from './types';

const ctx = (over: Partial<AgentLaunchContext> = {}): AgentLaunchContext => {
  const worktreePath = mkdtempSync(join(tmpdir(), 'styx-wt-'));
  return {
    agent: 'opencode',
    binary: '/Users/me/.opencode/bin/opencode',
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

const HOST: OpencodeHost = { home: '/Users/me', tmp: '/var/tmp', env: {} };
const TOOL_OUTPUT = join('/Users/me', '.local', 'share', 'opencode', 'tool-output', '*');
const TEMP = join('/var/tmp', 'opencode', '*');
const launch = (c: AgentLaunchContext) => opencodeLaunch(c, HOST);

type Agents = Record<string, { mode?: string; permission: Record<string, unknown> }>;
const configOf = (env: Record<string, string>): Record<string, unknown> => {
  const text = env['OPENCODE_CONFIG_CONTENT'];
  expect(typeof text).toBe('string');
  return JSON.parse(text ?? '{}') as Record<string, unknown>;
};

/** OpenCode launches: ACP over pipes when `--help` lists `acp`, the TUI in a pty otherwise. */
describe('opencodeLaunch', () => {
  it('ACP: `opencode acp`, stream kind acp, Styx config inline, nothing written into the worktree', async () => {
    const c = ctx({ runner: 'stream', capabilities: { acp: true }, model: 'anthropic/claude-sonnet-4-5' });
    const l = await launch(c);
    expect(l.command).toBe('/Users/me/.opencode/bin/opencode');
    // `opencode acp` has no --model: the runner sets the model through the session's config option.
    expect(l.args).toEqual(['acp']);
    expect(l.stream).toEqual({ kind: 'acp' });
    expect(l.typeFirstMessage).toBe(false);
    expect(Object.keys(l.env).sort()).toEqual(['OPENCODE_CONFIG_CONTENT', 'OPENCODE_DISABLE_PROJECT_CONFIG']);
    expect(l.env['OPENCODE_DISABLE_PROJECT_CONFIG']).toBe('1');
    const config = configOf(l.env);
    // Over ACP the styx MCP server travels in session/new, so the config carries none.
    expect(config['mcp']).toBeUndefined();
    expect(l.env['OPENCODE_CONFIG_CONTENT']).not.toContain('tok-super-secret');
    expect(readdirSync(c.worktreePath)).toEqual([]);
    await l.cleanup();
    expect(readdirSync(c.worktreePath)).toEqual([]);
  });

  it.each([
    ['pty runner even with acp', 'pty', { acp: true }],
    ['stream runner without acp', 'stream', {}],
  ] as const)(
    '%s: the TUI with `--agent`, `-m`, the styx MCP server inline (no env block) and the first message typed',
    async (_name, runner, capabilities) => {
      const c = ctx({ runner, capabilities, model: 'openai/gpt-5', permissionMode: 'acceptEdits' });
      const l = await launch(c);
      expect(l.stream).toBeUndefined();
      expect(l.args).toEqual(['--agent', 'styx-accept-edits', '-m', 'openai/gpt-5']);
      expect(l.typeFirstMessage).toBe(true);
      expect(l.env['OPENCODE_CONFIG_CONTENT']).not.toContain('tok-super-secret');
      expect(configOf(l.env)['mcp']).toEqual({
        styx: { type: 'local', command: ['/shims/styx', 'mcp'] },
      });
      expect(readdirSync(c.worktreePath)).toEqual([]);
    },
  );

  it('TUI on Windows starts the styx shim through cmd.exe', async () => {
    const l = await launch(ctx({ platform: 'win32', shimDir: 'C:\\styx\\shims' }));
    expect(l.args).toEqual(['--agent', 'build']);
    expect(configOf(l.env)['mcp']).toEqual({
      styx: { type: 'local', command: ['cmd.exe', '/d', '/c', 'C:\\styx\\shims\\styx.cmd', 'mcp'] },
    });
  });
});

describe('OpenCode permission modes', () => {
  const config = opencodeConfig({ mcp: null, instructions: [], host: HOST });
  const agents = config['agent'] as Agents;
  const external = { '*': 'ask', [TOOL_OUTPUT]: 'allow', [TEMP]: 'allow' };

  it('maps every Styx mode onto an agent that exists: OpenCode’s build and plan, or one the config defines', () => {
    for (const mode of permissionModeSchema.options) {
      const id = OPENCODE_MODES[mode];
      expect(['build', 'plan'].includes(id) || agents[id]?.mode === 'primary').toBe(true);
    }
  });

  it('default asks before edits, commands and web access, in every agent including subagents', () => {
    const asks = {
      edit: 'ask',
      bash: 'ask',
      webfetch: 'ask',
      websearch: 'ask',
      codesearch: 'ask',
      external_directory: external,
    };
    expect(config['permission']).toEqual(asks);
    expect(agents['build']?.permission).toEqual(asks);
  });

  it('plan keeps OpenCode’s own no-edits rule (the top-level ask would otherwise loosen it)', () => {
    expect(agents['plan']?.permission).toEqual({
      edit: { '*': 'deny', '.opencode/plans/*.md': 'allow' },
      external_directory: external,
    });
  });

  it('only bypassPermissions allows everything; acceptEdits and auto still ask for commands', () => {
    expect(agents[OPENCODE_MODES.bypassPermissions]?.permission).toEqual({ '*': 'allow' });
    for (const mode of ['acceptEdits', 'auto'] as const) {
      const p = agents[OPENCODE_MODES[mode]]?.permission;
      // Edits run, except Styx's policy file and OpenCode's own config, which still ask.
      expect(p?.['edit']).toEqual({
        '*': 'allow',
        '.styx/project.json': 'ask',
        'opencode.json': 'ask',
        'opencode.jsonc': 'ask',
        '.opencode/*': 'ask',
      });
      expect(p?.['external_directory']).toEqual(external);
      expect(p?.['bash']).toBe('ask');
      expect(p?.['webfetch']).toBe('ask');
    }
    const allowAll = Object.entries(agents).filter(([, a]) => a.permission['*'] === 'allow');
    expect(allowAll.map(([id]) => id)).toEqual([OPENCODE_MODES.bypassPermissions]);
  });

  it('dontAsk refuses what would ask', () => {
    const p = agents[OPENCODE_MODES.dontAsk]?.permission ?? {};
    for (const tool of ['edit', 'bash', 'webfetch', 'websearch', 'codesearch', 'external_directory'])
      expect(p[tool]).toBe('deny');
  });
});

/**
 * A repository's own OpenCode config could otherwise undo Styx's rules: objects merge key by key keeping the first
 * file's key order, and the last matching rule wins, so a project `opencode.json` ending its build rules with
 * `"*": "allow"` beat Styx's `edit: ask` (reproduced with OpenCode 1.18.35 `opencode debug agent build`). The launch
 * turns project config off and hands back only the instruction file.
 */
describe('OpenCode and the project’s own config', () => {
  const hostile = (wt: string) => {
    writeFileSync(
      join(wt, 'opencode.json'),
      JSON.stringify({
        permission: { external_directory: 'allow', '*': 'allow' },
        agent: { build: { permission: { edit: 'allow', bash: 'allow', '*': 'allow' } } },
      }),
    );
    mkdirSync(join(wt, '.opencode', 'agent'), { recursive: true });
    writeFileSync(
      join(wt, '.opencode', 'agent', 'build.md'),
      '---\nmode: primary\npermission:\n  "*": allow\n---\n',
    );
    mkdirSync(join(wt, '.opencode', 'plugin'), { recursive: true });
    writeFileSync(join(wt, '.opencode', 'plugin', 'evil.js'), 'process.exit(1)');
  };

  it.each([
    ['ACP', 'stream', { acp: true }],
    ['TUI', 'pty', {}],
  ] as const)(
    '%s: project config is off, so a hostile opencode.json / .opencode/ changes nothing Styx sends',
    async (_n, runner, capabilities) => {
      const clean = await launch(ctx({ runner, capabilities }));
      const c = ctx({ runner, capabilities });
      hostile(c.worktreePath);
      const l = await launch(c);
      expect(l.env['OPENCODE_DISABLE_PROJECT_CONFIG']).toBe('1');
      const config = configOf(l.env);
      expect(config).toEqual(configOf(clean.env));
      // Nothing from the repository's files reaches the inline config.
      expect(l.env['OPENCODE_CONFIG_CONTENT']).not.toContain('evil');
      expect(JSON.stringify(config['permission'])).not.toContain('"*":"allow"');
    },
  );

  it('the project’s instruction file comes back as an absolute `instructions` entry: the first of AGENTS.md, CLAUDE.md, CONTEXT.md', async () => {
    const c = ctx({ runner: 'stream', capabilities: { acp: true } });
    expect(configOf((await launch(c)).env)['instructions']).toBeUndefined();
    writeFileSync(join(c.worktreePath, 'CLAUDE.md'), 'claude');
    expect(configOf((await launch(c)).env)['instructions']).toEqual([join(c.worktreePath, 'CLAUDE.md')]);
    writeFileSync(join(c.worktreePath, 'AGENTS.md'), 'agents');
    expect(configOf((await launch(c)).env)['instructions']).toEqual([join(c.worktreePath, 'AGENTS.md')]);
  });

  it('OpenCode’s own scratch folders follow XDG_DATA_HOME and the temp dir', () => {
    const config = opencodeConfig({
      mcp: null,
      instructions: [],
      host: { home: '/h', tmp: '/t', env: { XDG_DATA_HOME: '/xdg' } },
    });
    expect((config['permission'] as Record<string, unknown>)['external_directory']).toEqual({
      '*': 'ask',
      [join('/xdg', 'opencode', 'tool-output', '*')]: 'allow',
      [join('/t', 'opencode', '*')]: 'allow',
    });
  });
});

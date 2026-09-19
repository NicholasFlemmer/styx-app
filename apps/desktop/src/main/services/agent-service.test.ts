import type { Agent, CliInstall } from '@styx/core';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeTestApp } from '../test-support';
import { AgentService } from './agent-service';
import type { AppServerIdentity } from './app-server-client';
import { PtyService } from './pty-service';

/** In-memory pty: records spawns, lets the test end the login command (same shape as target-cli.test.ts). */
class FakePty extends PtyService {
  readonly spawned: {
    id: string;
    shell: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
  }[] = [];
  private readonly live = new Set<string>();
  constructor() {
    super('darwin');
  }
  override async resolveLoginPath(): Promise<string> {
    return '/usr/local/bin:/usr/bin';
  }
  override async spawn(opts: {
    id: string;
    cwd: string;
    shell?: string;
    args?: string[];
    env?: Record<string, string>;
  }) {
    this.spawned.push({
      id: opts.id,
      shell: opts.shell ?? '',
      args: opts.args ?? [],
      cwd: opts.cwd,
      env: opts.env ?? {},
    });
    this.live.add(opts.id);
    return { pid: 4242 };
  }
  override write(): void {}
  override resize(): void {}
  override kill(id: string): void {
    this.exit(id, 0);
  }
  override has(id: string): boolean {
    return this.live.has(id);
  }
  override killAll(): void {
    for (const id of [...this.live]) this.kill(id);
  }
  exit(id: string, code: number): void {
    this.live.delete(id);
    this.emit('exit', id, code, undefined);
  }
}

type ExecResult = { stdout: string; stderr?: string; exitCode: number };
type ExecFake = (bin: string, args: string[]) => Promise<ExecResult>;
type AppServerFake = (bin: string) => Promise<AppServerIdentity | null>;

const CLAUDE_OK =
  '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"nic@acme.dev","orgName":"Acme","subscriptionType":"max"}\n';

/** No build under test has a working app-server unless a case says so. */
const NO_APP_SERVER: AppServerFake = async () => null;

function setup(
  exec: ExecFake = async () => ({ stdout: '', exitCode: 0 }),
  env: NodeJS.ProcessEnv = {},
  appServer: AppServerFake = NO_APP_SERVER,
  /** What the login shell's PATH holds for the install recipes' `requires` (`brew`, `npm`). */
  loginPath = '/usr/bin',
) {
  const pty = new FakePty();
  const t = makeTestApp({ pty });
  const home = mkdtempSync(join(tmpdir(), 'styx-agent-home-'));
  const execSpy = vi.fn(exec);
  const appServerSpy = vi.fn(appServer);
  const openExternal = vi.fn(async (_url: string) => undefined);
  const refreshClis = vi.fn(async () => t.app.repos.discovery.clis());
  const agents = new AgentService({
    repos: t.app.repos,
    publisher: t.app.publisher,
    clock: t.clock,
    terminals: t.app.terminals,
    pty,
    exec: execSpy,
    appServer: appServerSpy,
    openExternal,
    home,
    env,
    platform: 'darwin',
    loginPath: async () => loginPath,
    shell: () => '/bin/zsh',
    refreshClis,
    activity: t.app.activity,
  });
  return { ...t, pty, home, agents, exec: execSpy, appServer: appServerSpy, openExternal, refreshClis };
}

const row = (app: ReturnType<typeof setup>['app'], agent: Agent): CliInstall => {
  const r = app.repos.discovery.cli(agent);
  if (r === null) throw new Error(`no ${agent} row`);
  return r;
};

describe('AgentService.verify', () => {
  const cases: {
    name: string;
    agent: Agent;
    exec: ExecFake;
    expect: Partial<CliInstall>;
  }[] = [
    {
      name: 'claude: loggedIn JSON → signed in as the email',
      agent: 'claude',
      exec: async () => ({ stdout: CLAUDE_OK, exitCode: 0 }),
      expect: { authState: 'signed-in', account: 'nic@acme.dev', verifyError: null },
    },
    {
      name: 'claude: no email → the auth method stands in',
      agent: 'claude',
      exec: async () => ({
        stdout: '{"loggedIn":true,"authMethod":"console"}\nsome stderr noise\n',
        exitCode: 0,
      }),
      expect: { authState: 'signed-in', account: 'console', verifyError: null },
    },
    {
      name: 'claude: loggedIn false → signed out, account cleared',
      agent: 'claude',
      exec: async () => ({ stdout: '{"loggedIn":false}', exitCode: 0 }),
      expect: { authState: 'signed-out', account: null, verifyError: null },
    },
    {
      name: 'claude: non-zero exit → signed out',
      agent: 'claude',
      exec: async () => ({ stdout: 'Not logged in', exitCode: 1 }),
      expect: { authState: 'signed-out', account: null, verifyError: null },
    },
    {
      name: 'claude: malformed JSON → auth state and account untouched, verifyError set',
      agent: 'claude',
      exec: async () => ({ stdout: '{"loggedIn": tru', exitCode: 0 }),
      expect: { authState: 'signed-in', account: 'nic@acme.dev', verifyError: expect.stringMatching(/JSON/) },
    },
    {
      name: 'claude: JSON without loggedIn → unparsable',
      agent: 'claude',
      exec: async () => ({ stdout: '{"email":"x@y.z"}', exitCode: 0 }),
      expect: { authState: 'signed-in', verifyError: 'unexpected `claude auth status` output' },
    },
    {
      name: 'claude: exec throws → verifyError carries the message',
      agent: 'claude',
      exec: async () => {
        throw new Error('spawn ENOENT');
      },
      expect: { authState: 'signed-in', account: 'nic@acme.dev', verifyError: 'spawn ENOENT' },
    },
    {
      name: 'codex: "Logged in using ChatGPT"',
      agent: 'codex',
      exec: async () => ({ stdout: 'Logged in using ChatGPT\n', exitCode: 0 }),
      expect: { authState: 'signed-in', account: 'ChatGPT', verifyError: null },
    },
    {
      // codex 0.154.0 prints its status on stderr; a runner that keeps the streams apart still gets a verdict.
      name: 'codex: "Logged in using ChatGPT" on stderr only',
      agent: 'codex',
      exec: async () => ({ stdout: '', stderr: 'Logged in using ChatGPT\n', exitCode: 0 }),
      expect: { authState: 'signed-in', account: 'ChatGPT', verifyError: null },
    },
    {
      name: 'codex: API key login',
      agent: 'codex',
      exec: async () => ({ stdout: 'Logged in using an API key\n', exitCode: 0 }),
      expect: { authState: 'signed-in', account: 'API key', verifyError: null },
    },
    {
      name: 'codex: an unrecognised sign-in method is signed in with no account label (CLI output never lands in the row)',
      agent: 'codex',
      exec: async () => ({ stdout: '\nLogged in as ops@acme.dev\n', exitCode: 0 }),
      expect: { authState: 'signed-in', account: null, verifyError: null },
    },
    {
      name: 'codex: "Not logged in" → signed out',
      agent: 'codex',
      exec: async () => ({ stdout: 'Not logged in\n', exitCode: 0 }),
      expect: { authState: 'signed-out', account: null, verifyError: null },
    },
    {
      name: 'codex: unrecognised output → verifyError',
      agent: 'codex',
      exec: async () => ({ stdout: 'codex 0.9.3\n', exitCode: 0 }),
      expect: {
        authState: 'signed-in',
        account: 'ChatGPT',
        verifyError: 'unexpected `codex login status` output',
      },
    },
    {
      name: 'cursor: logged in with an email in the output',
      agent: 'cursor',
      exec: async () => ({ stdout: 'Status: Logged in\nAccount: nic@acme.dev\n', exitCode: 0 }),
      expect: { authState: 'signed-in', account: 'nic@acme.dev', verifyError: null },
    },
    {
      name: 'cursor: authenticated without an email → account unknown',
      agent: 'cursor',
      exec: async () => ({ stdout: 'Authenticated\n', exitCode: 0 }),
      expect: { authState: 'signed-in', account: null, verifyError: null },
    },
    {
      name: 'cursor: "Not authenticated" → signed out',
      agent: 'cursor',
      exec: async () => ({ stdout: 'Not authenticated. Run `agent login`.\n', exitCode: 0 }),
      expect: { authState: 'signed-out', account: null, verifyError: null },
    },
    {
      name: 'cursor: "not logged in" → signed out',
      agent: 'cursor',
      exec: async () => ({ stdout: 'You are not logged in\n', exitCode: 0 }),
      expect: { authState: 'signed-out', account: null, verifyError: null },
    },
    {
      name: 'cursor: unrecognised output → verifyError',
      agent: 'cursor',
      exec: async () => ({ stdout: '???\n', exitCode: 0 }),
      expect: { authState: 'signed-in', verifyError: 'unexpected `agent status` output' },
    },
  ];

  it.each(cases)('$name', async ({ agent, exec, expect: expected }) => {
    const { agents, app, clock, win } = setup(exec);
    const before = row(app, agent);
    const out = await agents.verify(agent);
    expect(out).toMatchObject({ ...expected, agent, binary: before.binary, verifiedAt: clock.now() });
    expect(row(app, agent)).toEqual(out);
    app.publisher.flush();
    expect(win.batches().flatMap((b) => b.deltas.map((d) => d.op))).toContain('discovery.set');
  });

  it('runs the status command through the row binary, never a hard-coded path', async () => {
    const { agents, app, exec } = setup(async () => ({ stdout: CLAUDE_OK, exitCode: 0 }));
    app.repos.discovery.saveCli({ ...row(app, 'claude'), binary: '/custom/bin/claude' });
    await agents.verify('claude');
    await agents.verify('codex');
    await agents.verify('cursor');
    expect(exec.mock.calls).toEqual([
      ['/custom/bin/claude', ['auth', 'status', '--json']],
      ['/opt/homebrew/bin/codex', ['login', 'status']],
      ['/opt/homebrew/bin/cursor-agent', ['status']],
    ]);
  });

  it('shell needs no check; a not-installed CLI comes back unchanged; an undetected one is synthesised, not saved', async () => {
    const { agents, app, exec, win } = setup();
    const shell = row(app, 'shell');
    expect(await agents.verify('shell')).toEqual({ ...shell, authState: 'n/a' });
    const missing: CliInstall = { ...row(app, 'codex'), found: false, binary: null, version: null };
    app.repos.discovery.saveCli(missing);
    expect(await agents.verify('codex')).toEqual(missing);
    app.publisher.flush();
    expect(win.batches().flatMap((b) => b.deltas.map((d) => d.op))).not.toContain('discovery.set');
    expect(exec).not.toHaveBeenCalled();
    const { agents: fresh, app: emptyApp } = setup();
    emptyApp.repos.discovery.replaceClis([]);
    expect(await fresh.verify('gemini')).toMatchObject({ agent: 'gemini', found: false, account: null });
    expect(emptyApp.repos.discovery.cli('gemini')).toBeNull();
  });

  it('gemini: oauth file + accounts file → the active Google account; env key alone → "API key"; nothing → signed out', async () => {
    const withOauth = setup();
    mkdirSync(join(withOauth.home, '.gemini'));
    writeFileSync(join(withOauth.home, '.gemini', 'oauth_creds.json'), '{"access_token":"ya29.secret"}');
    writeFileSync(
      join(withOauth.home, '.gemini', 'google_accounts.json'),
      '{"active":"nic@gmail.com","old":["x@y.z"]}',
    );
    expect(await withOauth.agents.verify('gemini')).toMatchObject({
      authState: 'signed-in',
      account: 'nic@gmail.com',
      verifyError: null,
    });
    expect(withOauth.exec).not.toHaveBeenCalled();
    withOauth.app.publisher.flush();
    expect(JSON.stringify([withOauth.app.repos.discovery.clis(), withOauth.win.sent])).not.toContain('ya29.');

    const keyOnly = setup(undefined, { GEMINI_API_KEY: 'AIza-secret' });
    expect(await keyOnly.agents.verify('gemini')).toMatchObject({
      authState: 'signed-in',
      account: 'API key',
    });
    expect(JSON.stringify(keyOnly.app.repos.discovery.clis())).not.toContain('AIza');

    const nothing = setup();
    expect(await nothing.agents.verify('gemini')).toMatchObject({ authState: 'signed-out', account: null });

    const malformed = setup();
    mkdirSync(join(malformed.home, '.gemini'));
    writeFileSync(join(malformed.home, '.gemini', 'oauth_creds.json'), '{}');
    writeFileSync(join(malformed.home, '.gemini', 'google_accounts.json'), 'not json');
    expect(await malformed.agents.verify('gemini')).toMatchObject({
      authState: 'signed-in',
      account: null,
      verifyError: null,
    });
  });

  it('nothing the CLI printed besides the identity reaches the row, the store or the window', async () => {
    const { agents, app, win } = setup(async () => ({
      stdout: '{"loggedIn":true,"email":"nic@acme.dev","accessToken":"sk-ant-oat01-SECRET"}',
      exitCode: 0,
    }));
    await agents.verify('claude');
    app.publisher.flush();
    expect(JSON.stringify([app.repos.discovery.clis(), app.publisher.snapshot(), win.sent])).not.toContain(
      'SECRET',
    );
  });
});

describe('AgentService.verify: Codex through its app-server (ADR-0016)', () => {
  const MODELS: AppServerIdentity['models'] = [
    {
      id: 'gpt-6-astra',
      label: 'GPT-6 Astra',
      description: null,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'low',
      isDefault: true,
      hidden: false,
    },
  ];
  const withAppServer = (t: ReturnType<typeof setup>) =>
    t.app.repos.discovery.saveCli({
      ...row(t.app, 'codex'),
      capabilities: { ...row(t.app, 'codex').capabilities, appServer: true },
    });

  it('a build with app-server: account is `email · plan`, the catalogue lands on the row, `login status` never runs', async () => {
    const t = setup(undefined, {}, async () => ({
      authState: 'signed-in',
      account: 'nic@acme.dev · team',
      models: MODELS,
    }));
    withAppServer(t);
    const out = await t.agents.verify('codex');
    expect(out).toMatchObject({
      authState: 'signed-in',
      account: 'nic@acme.dev · team',
      verifyError: null,
      capabilities: { appServer: true, mcp: true, models: MODELS },
    });
    expect(t.appServer).toHaveBeenCalledWith('/opt/homebrew/bin/codex');
    expect(t.exec).not.toHaveBeenCalled();
    expect(row(t.app, 'codex')).toEqual(out);
  });

  it('signed out according to account/read → signed out, no account', async () => {
    const t = setup(undefined, {}, async () => ({ authState: 'signed-out', account: null, models: [] }));
    withAppServer(t);
    expect(await t.agents.verify('codex')).toMatchObject({
      authState: 'signed-out',
      account: null,
      verifyError: null,
      capabilities: { models: [] },
    });
  });

  it('no working app-server (probe → null) → falls back to `codex login status`', async () => {
    const t = setup(async () => ({ stdout: '', stderr: 'Logged in using ChatGPT\n', exitCode: 0 }));
    withAppServer(t);
    expect(await t.agents.verify('codex')).toMatchObject({ authState: 'signed-in', account: 'ChatGPT' });
    expect(t.appServer).toHaveBeenCalledTimes(1);
    expect(t.exec).toHaveBeenCalledWith('/opt/homebrew/bin/codex', ['login', 'status']);
  });

  it('a row without the appServer capability is never probed that way', async () => {
    const t = setup(async () => ({ stdout: 'Logged in using ChatGPT\n', exitCode: 0 }));
    await t.agents.verify('codex');
    expect(t.appServer).not.toHaveBeenCalled();
    expect(t.exec).toHaveBeenCalledTimes(1);
  });

  it('a probe that fails after initialize records the failure and keeps the previous state', async () => {
    const t = setup(undefined, {}, async () => {
      throw new Error('account/read: token expired');
    });
    withAppServer(t);
    expect(await t.agents.verify('codex')).toMatchObject({
      authState: 'signed-in',
      account: 'ChatGPT',
      verifyError: 'account/read: token expired',
    });
    expect(t.exec).not.toHaveBeenCalled();
  });
});

describe('AgentService.login', () => {
  const table: [Agent, string, string[], string][] = [
    ['claude', '/opt/homebrew/bin/claude', ['auth', 'login'], 'claude auth login'],
    ['codex', '/opt/homebrew/bin/codex', ['login'], 'codex login'],
    ['cursor', '/opt/homebrew/bin/cursor-agent', ['login'], 'cursor-agent login'],
    ['gemini', '/opt/homebrew/bin/gemini', [], 'gemini'],
  ];

  it.each(table)(
    '%s runs `%s %s` in a pty from home and reports running',
    async (agent, bin, args, command) => {
      const { agents, app, pty, win, home } = setup();
      const r = await agents.login(agent);
      expect(r).toEqual({ terminalId: expect.stringMatching(/^term:/), command });
      expect(app.terminals.isTerminal(r.terminalId)).toBe(true);
      expect(pty.spawned).toEqual([{ id: r.terminalId, shell: bin, args, cwd: home, env: {} }]);
      expect(win.events('agent.login')).toEqual([{ terminalId: r.terminalId, agent, status: 'running' }]);
    },
  );

  it('exit reports exited with the code, drops the listener and re-verifies the row', async () => {
    const { agents, app, pty, win, exec, clock } = setup(async () => ({ stdout: CLAUDE_OK, exitCode: 0 }));
    app.repos.discovery.saveCli({
      ...row(app, 'claude'),
      authState: 'signed-out',
      account: null,
      verifiedAt: null,
    });
    const { terminalId } = await agents.login('claude');
    expect(exec).not.toHaveBeenCalled();
    clock.advance(60_000);
    pty.exit(terminalId, 0);
    await vi.waitFor(() =>
      expect(exec).toHaveBeenCalledWith('/opt/homebrew/bin/claude', ['auth', 'status', '--json']),
    );
    await vi.waitFor(() =>
      expect(row(app, 'claude')).toMatchObject({
        authState: 'signed-in',
        account: 'nic@acme.dev',
        verifiedAt: clock.now(),
      }),
    );
    expect(win.events('agent.login').at(-1)).toEqual({
      terminalId,
      agent: 'claude',
      status: 'exited',
      exitCode: 0,
    });
    pty.exit(terminalId, 1); // a second exit for the same id is ignored (listener removed)
    expect(win.events('agent.login')).toHaveLength(2);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('a failed sign-in still exits and re-verifies (the row says signed out)', async () => {
    const { agents, app, pty, win, exec } = setup(async () => ({ stdout: 'Not logged in', exitCode: 1 }));
    const { terminalId } = await agents.login('codex');
    pty.exit(terminalId, 130);
    expect(win.events('agent.login').at(-1)).toEqual({
      terminalId,
      agent: 'codex',
      status: 'exited',
      exitCode: 130,
    });
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(row(app, 'codex')).toMatchObject({ authState: 'signed-out', account: null }),
    );
  });

  it('shell has no sign-in; a missing CLI is cli-missing; nothing spawns either way', async () => {
    const { agents, app, pty } = setup();
    await expect(agents.login('shell')).rejects.toMatchObject({ code: 'invalid-input' });
    app.repos.discovery.saveCli({ ...row(app, 'codex'), found: false, binary: null });
    await expect(agents.login('codex')).rejects.toMatchObject({ code: 'cli-missing' });
    expect(pty.spawned).toHaveLength(0);
  });
});

describe('AgentService.install (#89)', () => {
  const missing = (app: ReturnType<typeof setup>['app'], agent: Agent) =>
    app.repos.discovery.saveCli({ ...row(app, agent), found: false, binary: null });
  const CLAUDE_INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';

  it('runs the vendor command in the login shell from home and reports running', async () => {
    const { agents, app, pty, win, home } = setup();
    missing(app, 'claude');
    const r = await agents.install('claude');
    expect(r).toEqual({ terminalId: expect.stringMatching(/^term:/), command: CLAUDE_INSTALL });
    expect(app.terminals.isTerminal(r.terminalId)).toBe(true);
    expect(pty.spawned).toEqual([
      { id: r.terminalId, shell: '/bin/zsh', args: ['-ilc', CLAUDE_INSTALL], cwd: home, env: {} },
    ]);
    expect(win.events('agent.install')).toEqual([
      { terminalId: r.terminalId, agent: 'claude', status: 'running' },
    ]);
  });

  it('gemini: Homebrew when the login PATH has brew, npm otherwise, a clear refusal with neither', async () => {
    const tools = mkdtempSync(join(tmpdir(), 'styx-tools-'));
    const tool = (name: string) => {
      writeFileSync(join(tools, name), '#!/bin/sh\n');
      chmodSync(join(tools, name), 0o755);
    };
    tool('npm');
    const npmOnly = setup(undefined, {}, NO_APP_SERVER, tools);
    missing(npmOnly.app, 'gemini');
    expect((await npmOnly.agents.install('gemini')).command).toBe('npm install -g @google/gemini-cli');
    tool('brew');
    const both = setup(undefined, {}, NO_APP_SERVER, tools);
    missing(both.app, 'gemini');
    expect((await both.agents.install('gemini')).command).toBe('brew install gemini-cli');
    const neither = setup(undefined, {}, NO_APP_SERVER, mkdtempSync(join(tmpdir(), 'styx-empty-')));
    missing(neither.app, 'gemini');
    await expect(neither.agents.install('gemini')).rejects.toMatchObject({
      code: 'not-found',
      message:
        'No installer for Gemini CLI on this machine: install it with your package manager, then rescan.',
    });
    expect(neither.pty.spawned).toHaveLength(0);
  });

  it('exit re-detects, re-verifies the now-installed row, logs the activity, and only then reports exited', async () => {
    const { agents, app, pty, win, exec, refreshClis } = setup(async () => ({
      stdout: CLAUDE_OK,
      exitCode: 0,
    }));
    missing(app, 'claude');
    // The re-detect finds the fresh binary in its install folder (the fake writes the row the detector would).
    refreshClis.mockImplementation(async () => {
      app.repos.discovery.saveCli({
        ...row(app, 'claude'),
        found: true,
        binary: '/Users/nic/.local/bin/claude',
        version: '2.1.300',
      });
      return app.repos.discovery.clis();
    });
    const { terminalId } = await agents.install('claude');
    pty.exit(terminalId, 0);
    await vi.waitFor(() =>
      expect(win.events('agent.install').at(-1)).toEqual({
        terminalId,
        agent: 'claude',
        status: 'exited',
        exitCode: 0,
      }),
    );
    expect(refreshClis).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('/Users/nic/.local/bin/claude', ['auth', 'status', '--json']);
    expect(row(app, 'claude')).toMatchObject({
      found: true,
      authState: 'signed-in',
      account: 'nic@acme.dev',
    });
    expect(app.repos.activity.recent(1)[0]).toMatchObject({
      who: 'you',
      what: `Claude Code · installed (${CLAUDE_INSTALL})`,
      projectId: null,
      sessionId: null,
    });
    pty.exit(terminalId, 1); // a second exit for the same id is ignored (listener removed)
    expect(win.events('agent.install')).toHaveLength(2);
  });

  it('a failed installer still re-detects, but verifies nothing and logs nothing', async () => {
    const { agents, app, pty, win, exec, refreshClis } = setup();
    missing(app, 'codex');
    const before = app.repos.activity.recent(100).length;
    const { terminalId } = await agents.install('codex');
    pty.exit(terminalId, 1);
    await vi.waitFor(() =>
      expect(win.events('agent.install').at(-1)).toMatchObject({ status: 'exited', exitCode: 1 }),
    );
    expect(refreshClis).toHaveBeenCalledTimes(1);
    expect(exec).not.toHaveBeenCalled();
    expect(app.repos.activity.recent(100)).toHaveLength(before);
  });

  it('shell has nothing to install; an installed CLI is refused; nothing spawns either way', async () => {
    const { agents, pty } = setup();
    await expect(agents.install('shell')).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(agents.install('claude')).rejects.toMatchObject({ code: 'invalid-transition' });
    expect(pty.spawned).toHaveLength(0);
  });
});

describe('AgentService.installGuide', () => {
  it('opens each CLI docs page in the OS browser; shell has none', async () => {
    const { agents, openExternal } = setup();
    for (const agent of ['claude', 'codex', 'gemini', 'cursor'] as const) await agents.installGuide(agent);
    expect(openExternal.mock.calls.map((c) => c[0])).toEqual([
      'https://docs.claude.com/en/docs/claude-code/setup',
      'https://github.com/openai/codex',
      'https://github.com/google-gemini/gemini-cli',
      'https://cursor.com/docs/cli',
    ]);
    await expect(agents.installGuide('shell')).rejects.toMatchObject({ code: 'invalid-input' });
    expect(openExternal).toHaveBeenCalledTimes(4);
  });
});

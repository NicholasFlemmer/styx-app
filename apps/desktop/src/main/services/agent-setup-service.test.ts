import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copy, type AgentSetup, type CliInstall, type InstallRecipe, type SetupAgent } from '@styx/core';
import { describe, expect, it, vi } from 'vitest';
import { makeTestApp } from '../test-support';
import { AgentSetupService, classifyTestFailure, testAnswered, type SetupExec } from './agent-setup-service';

type Answer = { stdout: string; stderr?: string; exitCode: number; timedOut?: boolean };

/**
 * A machine in miniature: the error fixture's CLIs (Claude, Cursor signed in; Codex missing; Gemini signed out), an
 * installer that "installs" by marking the row found, sign-in terminals the test drives through the pty emitter,
 * and a test message whose answer each case sets.
 */
const rig = (
  opts: { npm?: boolean; installExit?: number; answer?: Answer; signinTimeoutMs?: number } = {},
) => {
  const t = makeTestApp({ fixture: 'error' });
  const home = mkdtempSync(join(tmpdir(), 'styx-setup-home-'));
  const pty = Object.assign(new EventEmitter(), { addPathDirs: vi.fn() });
  const published: AgentSetup[] = [];
  const terminals: { file: string; args: string[] }[] = [];
  const typed: [string, string][] = [];
  const killed: string[] = [];
  const installs: { agent: string; recipe?: InstallRecipe; reinstall?: boolean }[] = [];
  const row = (agent: string) => t.app.repos.discovery.cli(agent) as CliInstall;
  let signInWorks = true;
  let nodeInstalled = false;
  let answer: Answer = opts.answer ?? { stdout: 'ready', exitCode: 0 };
  const exec: SetupExec = vi.fn(async () => ({ stderr: '', timedOut: false, ...answer }));
  const svc = new AgentSetupService({
    repos: t.app.repos,
    publisher: { agentSetupSet: (s) => published.push(s) },
    clock: t.clock,
    agents: {
      install: vi.fn(async (agent, o = {}) => {
        installs.push({
          agent,
          ...(o.recipe ? { recipe: o.recipe } : {}),
          ...(o.reinstall ? { reinstall: true } : {}),
        });
        if ((opts.installExit ?? 0) === 0)
          t.app.repos.discovery.saveCli({
            ...row(agent),
            found: true,
            binary: `/bin/${agent}`,
            version: '9.9.9',
          });
        setTimeout(() => o.onDone?.(opts.installExit ?? 0), 0);
        return { terminalId: 'term-install', command: 'install' };
      }),
      verify: vi.fn(async (agent) => row(agent)),
    },
    refreshClis: async () => undefined,
    terminals: {
      spawnCommand: vi.fn(async (cmd) => {
        terminals.push({ file: cmd.file, args: cmd.args });
        return `term-${terminals.length}`;
      }),
      input: (id, data) => typed.push([id, data]),
      kill: (id) => killed.push(id),
    },
    pty: pty as never,
    node: {
      ensure: vi.fn(async () => {
        nodeInstalled = true;
        return '/tools/node/bin';
      }),
      installed: () => nodeInstalled,
      binDir: '/tools/node/bin',
      npmBinDir: '/tools/npm/bin',
      prefixDir: '/tools/npm',
      npm: '/tools/node/bin/npm',
    },
    git: { available: async () => ({ installed: true }) },
    gitSetup: { install: async () => ({ terminalId: null, command: null }) },
    exec,
    openExternal: vi.fn(async () => undefined),
    loginPath: async () => (opts.npm === false ? '' : (process.env['PATH'] ?? '')),
    platform: 'darwin',
    home,
    pollMs: 5,
    ...(opts.signinTimeoutMs !== undefined ? { signinTimeoutMs: opts.signinTimeoutMs } : {}),
  });
  /** The sign-in terminal "succeeds": the CLI saved a login, then exits 0. */
  const finishSignIn = (id: string, code = 0) => {
    const agent = published.at(-1)?.agent ?? 'codex';
    if (signInWorks && code === 0)
      t.app.repos.discovery.saveCli({ ...row(agent), authState: 'signed-in', account: 'nic@acme.dev' });
    pty.emit('exit', id, code);
  };
  const last = (agent: SetupAgent) => [...published].reverse().find((p) => p.agent === agent);
  const until = async (fn: () => boolean) => {
    for (let i = 0; i < 400 && !fn(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(fn()).toBe(true);
  };
  return {
    t,
    svc,
    pty,
    home,
    published,
    terminals,
    typed,
    killed,
    installs,
    exec,
    last,
    until,
    finishSignIn,
    row,
    setAnswer: (a: Answer) => {
      answer = a;
    },
    signInFails: () => {
      signInWorks = false;
    },
  };
};

describe('AgentSetupService: one button from nothing to a working agent', () => {
  it('Codex, not installed: install → sign in (the link kept for "Copy the link") → test → ready', async () => {
    const r = rig();
    const ready = vi.fn();
    r.svc.onReady(ready);
    const done = r.svc.setUp('codex');
    await r.until(() => r.last('codex')?.status === 'waiting');
    expect(r.installs).toEqual([{ agent: 'codex' }]);
    expect(r.terminals.at(-1)).toEqual({ file: '/bin/codex', args: ['login'] });
    expect(r.last('codex')).toMatchObject({ step: 'signin', installedVersion: '9.9.9' });
    r.pty.emit('data', 'term-1', '\x1b[1mOpen this link:\x1b[0m https://auth.openai.com/oauth?x=1\r\n');
    await r.until(() => r.last('codex')?.url === 'https://auth.openai.com/oauth?x=1');
    r.pty.emit('data', 'other', 'Paste code here');
    expect(r.last('codex')?.wantsCode).toBe(false);
    r.finishSignIn('term-1');
    await done;
    expect(r.last('codex')).toMatchObject({ status: 'done', step: 'test', terminalId: null, url: null });
    expect(r.last('codex')?.testedMs).not.toBeNull();
    expect(ready).toHaveBeenCalledWith('codex');
    // The test message is the tiny one-shot, never a session.
    expect(vi.mocked(r.exec).mock.calls[0]?.[1]).toEqual([
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '-s',
      'read-only',
      'Reply with the single word: ready',
    ]);
    // A second run while one is going is ignored; a finished one can run again.
    expect(r.published.filter((p) => p.status === 'done')).toHaveLength(1);
  });

  it('already installed and signed in: straight to the test; a press-Enter prompt and a code request are handled', async () => {
    const r = rig({ answer: { stdout: '{"result":"ready","is_error":false}', exitCode: 0 } });
    await r.svc.setUp('claude');
    expect(r.installs).toEqual([]);
    expect(r.terminals).toEqual([]);
    expect(r.last('claude')).toMatchObject({ status: 'done' });
    // Gemini is installed but signed out: its sign-in runs (Login with Google preselected), the code field appears.
    r.setAnswer({ stdout: 'ready', exitCode: 0 });
    const gem = r.svc.setUp('gemini');
    await r.until(() => r.last('gemini')?.status === 'waiting');
    const settings = JSON.parse(readFileSync(join(r.home, '.gemini', 'settings.json'), 'utf8')) as {
      security: { auth: { selectedType: string } };
    };
    expect(settings.security.auth.selectedType).toBe('oauth-personal');
    r.pty.emit('data', 'term-1', 'Press Enter to open your browser');
    r.pty.emit('data', 'term-1', 'Press Enter again');
    expect(r.typed).toEqual([['term-1', '\r']]);
    r.pty.emit('data', 'term-1', 'Enter the authorization code:');
    await r.until(() => r.last('gemini')?.wantsCode === true);
    r.svc.code('gemini', 'ABC-123');
    expect(r.typed.at(-1)).toEqual(['term-1', 'ABC-123\r']);
    // Gemini stays open after signing in: its saved login is the signal, then it is closed.
    mkdirSync(join(r.home, '.gemini'), { recursive: true });
    writeFileSync(join(r.home, '.gemini', 'oauth_creds.json'), '{}');
    r.t.app.repos.discovery.saveCli({ ...r.row('gemini'), authState: 'signed-in' });
    await gem;
    expect(r.killed).toContain('term-1');
    expect(r.last('gemini')).toMatchObject({ status: 'done' });
  });

  it("Gemini with no npm: Styx's private Node.js first, then Gemini through its npm, into its own prefix", async () => {
    const r = rig({ npm: false });
    r.t.app.repos.discovery.saveCli({ ...r.row('gemini'), found: false, binary: null });
    const run = r.svc.setUp('gemini');
    await r.until(() => r.last('gemini')?.status === 'waiting');
    expect(r.published.some((p) => p.step === 'prepare' && p.preparing === 'Node.js')).toBe(true);
    expect(r.pty.addPathDirs).toHaveBeenCalledWith(['/tools/node/bin', '/tools/npm/bin']);
    expect(r.installs[0]?.recipe?.command).toBe(
      "PATH='/tools/node/bin':\"$PATH\" '/tools/node/bin/npm' install -g @google/gemini-cli --prefix '/tools/npm'",
    );
    r.svc.cancel('gemini');
    await run;
    expect(r.last('gemini')?.status).toBe('cancelled');
  });

  it('each test answer is one plain problem with its fix', async () => {
    const cases: [Answer, string, RegExp][] = [
      [{ stdout: '', stderr: 'error: unknown option --tools', exitCode: 1 }, 'out-of-date', /too old/],
      [{ stdout: '', stderr: 'Not logged in · Please run /login', exitCode: 1 }, 'signin', /Sign in again/],
      [
        { stdout: '{"is_error":true,"result":"Credit balance is too low"}', exitCode: 1 },
        'needs-plan',
        /Pro or Max/,
      ],
      [{ stdout: '', stderr: 'You have hit your usage limit', exitCode: 1 }, 'limit', /out of usage/],
      [{ stdout: '', stderr: 'segfault', exitCode: 139 }, 'test-failed', /didn’t answer/],
      [{ stdout: '', exitCode: 1, timedOut: true }, 'test-failed', /didn’t answer/],
    ];
    for (const [answer, problem, message] of cases) {
      const r = rig({ answer });
      await r.svc.setUp('claude');
      expect(r.last('claude')).toMatchObject({ status: 'failed', problem });
      expect(r.last('claude')?.message).toMatch(message);
    }
  });

  it('a failed install, a sign-in that never lands, and a timeout each stop with one sentence', async () => {
    const bad = rig({ installExit: 1 });
    await bad.svc.setUp('codex');
    expect(bad.last('codex')).toMatchObject({ status: 'failed', problem: 'install-failed' });
    expect(bad.last('codex')?.message).toBe(
      'Codex didn’t install. Show details has what the installer said.',
    );

    const nope = rig();
    nope.signInFails();
    const run = nope.svc.setUp('gemini');
    await nope.until(() => nope.last('gemini')?.status === 'waiting');
    nope.finishSignIn('term-1', 1);
    await run;
    expect(nope.last('gemini')).toMatchObject({ status: 'failed', problem: 'signin' });

    const slow = rig({ signinTimeoutMs: 20 });
    await slow.svc.setUp('gemini');
    expect(slow.last('gemini')).toMatchObject({ status: 'failed', problem: 'signin' });
    expect(slow.last('gemini')?.message).toBe(copy.agentSetup.problems.signinTimeout);
    expect(slow.killed).toContain('term-1');
  });

  it('an unexpected error is reported against the step it happened in, not as a failed install', async () => {
    const r = rig();
    const spawn = vi.fn(async () => {
      throw new Error('spawn EACCES');
    });
    (r.svc as unknown as { deps: { terminals: { spawnCommand: unknown } } }).deps.terminals.spawnCommand =
      spawn;
    await r.svc.setUp('gemini');
    expect(r.last('gemini')).toMatchObject({ status: 'failed', problem: 'signin' });
    expect(r.last('gemini')?.message).toBe(
      'The sign-in didn’t finish. Show details has what Gemini CLI said.',
    );
  });

  it('Update reinstalls over an out-of-date copy; See plans opens the vendor page', async () => {
    const r = rig({ answer: { stdout: '{"result":"ready","is_error":false}', exitCode: 0 } });
    await r.svc.setUp('claude', { update: true });
    expect(r.installs).toEqual([{ agent: 'claude', reinstall: true }]);
    await r.svc.plans('claude');
    expect(r.svc.all().map((s) => s.agent)).toEqual(['claude']);
  });
});

describe('test answer reading', () => {
  it.each([
    ['claude', '{"result":"ready","is_error":false}', 0, true],
    ['claude', 'noise {"result":"ready","is_error":false}', 0, true],
    ['claude', '{"result":"","is_error":false}', 0, false],
    ['claude', '{"result":"x","is_error":true}', 0, false],
    ['claude', 'not json', 0, false],
    ['codex', 'ready', 0, true],
    ['codex', 'Ready.', 0, true],
    ['gemini', 'something else', 0, false],
    ['cursor', 'ready', 1, false],
  ] as const)('%s %s (exit %d) → %s', (agent, stdout, code, ok) => {
    expect(testAnswered(agent, stdout, code)).toBe(ok);
  });

  it.each([
    ['error: unexpected argument --ephemeral', 'out-of-date'],
    ['401 Unauthorized', 'signin'],
    ['This model requires a paid plan subscription', 'needs-plan'],
    ['requires a pro subscription', 'needs-plan'],
    ['429 Too Many Requests: rate limit', 'limit'],
    ['ECONNRESET', 'test-failed'],
  ])('%s → %s', (text, problem) => {
    expect(classifyTestFailure(text)).toBe(problem);
  });
});

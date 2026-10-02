import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  copy,
  fill,
  type AgentSetup,
  type CliInstall,
  type InstallRecipe,
  type SetupAgent,
  type SetupProblem,
  type SetupStep,
} from '@styx/core';
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import type { Publisher } from '../store/publisher';
import type { AgentService } from './agent-service';
import { findOnPath } from './detect-service';
import type { GitSetupService } from './git-setup-service';
import { logger } from './logger';
import type { NodeToolService } from './node-tool-service';
import type { PtyService } from './pty-service';
import type { TerminalService } from './terminal-service';

/** A one-shot run of a CLI (the test message): never throws; `timedOut` when it had to be stopped. */
export type SetupExec = (
  bin: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>;

export interface AgentSetupDeps {
  repos: Repos;
  publisher: Pick<Publisher, 'agentSetupSet'>;
  clock: Clock;
  agents: Pick<AgentService, 'install' | 'verify'>;
  refreshClis: () => Promise<unknown>;
  terminals: Pick<TerminalService, 'spawnCommand' | 'input' | 'kill'>;
  pty: Pick<PtyService, 'on' | 'off' | 'addPathDirs'>;
  node: Pick<NodeToolService, 'ensure' | 'installed' | 'binDir' | 'npmBinDir' | 'prefixDir' | 'npm'>;
  git: { available: () => Promise<{ installed: boolean }> };
  gitSetup: Pick<GitSetupService, 'install'>;
  exec: SetupExec;
  openExternal: (url: string) => Promise<void>;
  loginPath: () => Promise<string>;
  platform: NodeJS.Platform;
  home: string;
  /** Sign-in waits this long for the browser before giving up (10 minutes). */
  signinTimeoutMs?: number;
  /** How often Gemini's saved login is looked for while it signs in. */
  pollMs?: number;
}

/** The test message: one word back, the smallest ask a plan can answer. */
const PROMPT = 'Reply with the single word: ready';
const TEST_TIMEOUT_MS = 120_000;

/**
 * What each CLI is asked for the test. Claude: the smallest model, no tools, settings or MCP servers, one turn, so it
 * costs a fraction of a cent (measured 2026-10-02: $0.0007 against $0.15 for a default `-p`).
 */
const TEST_ARGS: Record<SetupAgent, string[]> = {
  claude: [
    '-p',
    PROMPT,
    '--model',
    'haiku',
    '--system-prompt',
    'Reply with one word.',
    '--tools',
    '',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--max-turns',
    '1',
    '--no-session-persistence',
    '--output-format',
    'json',
  ],
  codex: ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', PROMPT],
  gemini: ['-p', PROMPT],
  cursor: ['-p', PROMPT, '--output-format', 'text'],
};

/** The CLI's own browser sign-in; Gemini signs in on its first run (with "Login with Google" preselected). */
const SIGNIN_ARGS: Record<SetupAgent, string[]> = {
  claude: ['auth', 'login'],
  codex: ['login'],
  cursor: ['login'],
  gemini: [],
};

const PLAN_PAGES: Record<SetupAgent, string> = {
  claude: 'https://claude.com/pricing',
  codex: 'https://chatgpt.com/pricing',
  gemini: 'https://gemini.google/subscriptions/',
  cursor: 'https://cursor.com/pricing',
};

/** What the plan needs, for "this account doesn't include …; it needs {plan}". */
const PLAN_NAMES: Record<SetupAgent, string> = {
  claude: 'Claude Pro or Max',
  codex: 'a ChatGPT plan',
  gemini: 'a Google account',
  cursor: 'a Cursor plan',
};

// Output classification for the test (and its order): a flag the CLI does not know means it is out of date; then
// sign-in, plan and limit answers. Matched on stdout + stderr, never shown.
const OUT_OF_DATE =
  /unknown option|unexpected argument|unrecognized (option|argument)|no such option|requires a newer version|please update/i;
const SIGNED_OUT =
  /not logged in|please run \/login|run `?\w+ login|invalid api key|unauthori[sz]ed|\b401\b|login required|authentication (failed|required)|not authenticated/i;
const NEEDS_PLAN =
  /credit balance is too low|does not have access|not (included|available) (in|on) your plan|upgrade your plan|requires a (paid|pro|max) (plan|subscription)|no active subscription/i;
const LIMIT = /usage limit|rate limit|quota|\b429\b|limit (reached|exceeded)|out of (usage|credits)/i;

export const classifyTestFailure = (text: string): SetupProblem => {
  if (OUT_OF_DATE.test(text)) return 'out-of-date';
  if (SIGNED_OUT.test(text)) return 'signin';
  if (NEEDS_PLAN.test(text)) return 'needs-plan';
  if (LIMIT.test(text)) return 'limit';
  return 'test-failed';
};

/** Whether a test's output is a real answer (Claude's JSON says so; the others print the reply). */
export const testAnswered = (agent: SetupAgent, stdout: string, exitCode: number): boolean => {
  if (exitCode !== 0) return false;
  if (agent === 'claude') {
    try {
      const start = stdout.indexOf('{');
      const parsed = JSON.parse(stdout.slice(start)) as { is_error?: unknown; result?: unknown };
      return parsed.is_error !== true && typeof parsed.result === 'string' && parsed.result.trim() !== '';
    } catch {
      return false;
    }
  }
  return /\bready\b/i.test(stdout);
};

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[@-Z\\-_]/g;
const URL_IN = /https:\/\/[^\s"'<>\x1b]+/;
const WANTS_CODE = /paste (the )?code|enter (the )?(authorization |verification )?code|code here/i;
const PRESS_ENTER = /press enter/i;

const quoteSh = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const quotePs = (s: string): string => `'${s.replace(/'/g, "''")}'`;

class Cancelled extends Error {}
class StepFailed extends Error {
  constructor(
    readonly problem: SetupProblem,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Agent setup (owner request, design/next/styx-next-agent-setup.html): one button per plan runs the whole chain
 * for an agent, out of sight — prepare what it needs (a private Node.js for Gemini, git on Windows for Claude's
 * Bash tool), install the CLI with its vendor's installer, sign in through the CLI's own browser flow, and send one
 * tiny test message — skipping whatever is already done. Each change re-publishes the agent's row
 * (`agentSetup.set`); a step that fails stops the run with one plain sentence and the problem the card offers a
 * fix for. Nothing here reads or stores a credential: the CLIs keep their own.
 */
export class AgentSetupService {
  private readonly runs = new Map<SetupAgent, AgentSetup>();
  private readonly cancels = new Map<SetupAgent, () => void>();
  private readonly readyListeners = new Set<(agent: SetupAgent) => void>();

  constructor(private readonly deps: AgentSetupDeps) {}

  all(): AgentSetup[] {
    return [...this.runs.values()];
  }

  /** Called once an agent finishes a run ready (sessions waiting on a sign-in resend their message). */
  onReady(fn: (agent: SetupAgent) => void): () => void {
    this.readyListeners.add(fn);
    return () => this.readyListeners.delete(fn);
  }

  /** Starts a run unless one is going; resolves once the run ends (the IPC handler does not wait for it). */
  async setUp(agent: SetupAgent, opts: { update?: boolean } = {}): Promise<void> {
    const cur = this.runs.get(agent);
    if (cur !== undefined && (cur.status === 'running' || cur.status === 'waiting')) return;
    const now = this.deps.clock.now();
    this.set(agent, {
      agent,
      status: 'running',
      step: 'install',
      preparing: null,
      installedVersion: null,
      installMs: null,
      testedMs: null,
      url: null,
      wantsCode: false,
      problem: null,
      message: null,
      terminalId: null,
      startedAt: now,
      updatedAt: now,
    });
    let cancelled = false;
    this.cancels.set(agent, () => {
      cancelled = true;
    });
    const guard = () => {
      if (cancelled) throw new Cancelled();
    };
    try {
      await this.run(agent, opts.update === true, guard);
      const tested = this.runs.get(agent);
      logger.info('agent setup: ready', { agent, testedMs: tested?.testedMs ?? null });
      this.patch(agent, { status: 'done', terminalId: null, url: null, wantsCode: false });
      for (const fn of this.readyListeners) fn(agent);
    } catch (e) {
      if (e instanceof Cancelled || cancelled) this.patch(agent, { status: 'cancelled', terminalId: null });
      else if (e instanceof StepFailed) {
        logger.warn('agent setup: stopped', { agent, problem: e.problem });
        this.patch(agent, { status: 'failed', problem: e.problem, message: e.message });
      } else {
        const message = e instanceof Error ? e.message : String(e);
        logger.warn('agent setup: failed', { agent, error: message });
        this.patch(agent, {
          status: 'failed',
          problem: 'install-failed',
          message: fill(copy.agentSetup.problems.install, { product: copy.agentProducts[agent] }),
        });
      }
    } finally {
      this.cancels.delete(agent);
    }
  }

  cancel(agent: SetupAgent): void {
    const run = this.runs.get(agent);
    this.cancels.get(agent)?.();
    if (run?.terminalId) this.deps.terminals.kill(run.terminalId);
  }

  /** The code a browser shows when it cannot reach the CLI; typed into the waiting sign-in. */
  code(agent: SetupAgent, code: string): void {
    const run = this.runs.get(agent);
    if (run?.terminalId) this.deps.terminals.input(run.terminalId, `${code}\r`);
  }

  async plans(agent: SetupAgent): Promise<void> {
    await this.deps.openExternal(PLAN_PAGES[agent]);
  }

  // --- the chain ---------------------------------------------------------------

  private async run(agent: SetupAgent, update: boolean, guard: () => void): Promise<void> {
    const product = copy.agentProducts[agent];
    let cli = this.deps.repos.discovery.cli(agent);
    if (update || cli === null || !cli.found) {
      await this.prepare(agent, guard);
      cli = await this.install(agent, update, guard);
    }
    guard();
    this.patch(agent, { step: 'signin', status: 'running' });
    let row = await this.deps.agents.verify(agent);
    if (row.authState !== 'signed-in') {
      await this.signIn(agent, row, guard);
      row = await this.deps.agents.verify(agent);
      if (row.authState !== 'signed-in')
        throw new StepFailed('signin', fill(copy.agentSetup.problems.signinFailed, { product }));
    }
    guard();
    this.patch(agent, { step: 'test', status: 'running', terminalId: null, url: null, wantsCode: false });
    await this.test(agent, row, guard);
  }

  private async prepare(agent: SetupAgent, guard: () => void): Promise<void> {
    const { platform } = this.deps;
    if (agent === 'gemini' && !(await this.hasNpm())) {
      this.patch(agent, { step: 'prepare', preparing: 'Node.js' });
      try {
        await this.deps.node.ensure();
      } catch (e) {
        logger.warn('agent setup: Node.js download failed', { error: (e as Error).message });
        throw new StepFailed('prepare-failed', copy.agentSetup.problems.prepareNode);
      }
      this.deps.pty.addPathDirs([this.deps.node.binDir, this.deps.node.npmBinDir]);
      guard();
    }
    // Claude Code on Windows uses Git Bash for its Bash tool (PowerShell without it): installed alongside, and a
    // failure here never stops Claude's setup.
    if (agent === 'claude' && platform === 'win32' && !(await this.deps.git.available()).installed) {
      this.patch(agent, { step: 'prepare', preparing: 'Git' });
      const r = await this.deps.gitSetup.install().catch(() => ({ terminalId: null }));
      if (r.terminalId !== null) {
        this.patch(agent, { terminalId: r.terminalId });
        await this.exitOf(r.terminalId);
      }
      guard();
    }
  }

  private async install(agent: SetupAgent, update: boolean, guard: () => void): Promise<CliInstall> {
    const product = copy.agentProducts[agent];
    this.patch(agent, { step: 'install', status: 'running' });
    const started = this.deps.clock.now();
    const recipe = agent === 'gemini' && this.deps.node.installed() ? this.privateNpmRecipe() : undefined;
    const exitCode = await new Promise<number>((resolve, reject) => {
      this.deps.agents
        .install(agent, {
          ...(recipe !== undefined ? { recipe } : {}),
          reinstall: update,
          onDone: resolve,
        })
        .then((r) => this.patch(agent, { terminalId: r.terminalId }))
        .catch(reject);
    });
    guard();
    if (exitCode !== 0)
      throw new StepFailed('install-failed', fill(copy.agentSetup.problems.install, { product }));
    await this.deps.refreshClis();
    const cli = this.deps.repos.discovery.cli(agent);
    if (cli === null || !cli.found)
      throw new StepFailed(
        'install-failed',
        fill(copy.agentSetup.problems.notFoundAfterInstall, { product }),
      );
    this.patch(agent, {
      installedVersion: cli.version,
      installMs: this.deps.clock.now() - started,
      terminalId: null,
    });
    return cli;
  }

  /** Gemini through Styx's own npm, into Styx's own prefix (no administrator prompt, nothing global). */
  private privateNpmRecipe(): InstallRecipe {
    const { node, platform } = this.deps;
    const pkg = '@google/gemini-cli';
    if (platform === 'win32')
      return {
        command: `$env:Path = ${quotePs(`${node.binDir};`)} + $env:Path; & ${quotePs(node.npm)} install -g ${pkg} --prefix ${quotePs(node.prefixDir)}`,
        shell: 'powershell',
        requires: null,
      };
    return {
      command: `PATH=${quoteSh(node.binDir)}:"$PATH" ${quoteSh(node.npm)} install -g ${pkg} --prefix ${quoteSh(node.prefixDir)}`,
      shell: 'sh',
      requires: null,
    };
  }

  /**
   * The CLI's own sign-in, in a hidden terminal: the link it prints is kept for "Copy the link", a "press Enter" is
   * answered, a request for a code turns on the card's code field, and the run waits for the CLI to finish (Gemini:
   * for its saved login to appear, then it is closed). Ten minutes, then it gives up.
   */
  private async signIn(agent: SetupAgent, cli: CliInstall, guard: () => void): Promise<void> {
    const product = copy.agentProducts[agent];
    const binary = cli.binary;
    if (binary === null)
      throw new StepFailed('signin', fill(copy.agentSetup.problems.signinFailed, { product }));
    if (agent === 'gemini') this.preselectGoogleLogin();
    const started = Date.now();
    const terminalId = await this.deps.terminals.spawnCommand({
      file: binary,
      args: SIGNIN_ARGS[agent],
      cwd: this.deps.home,
    });
    this.patch(agent, { status: 'waiting', terminalId });
    const runCancel = this.cancels.get(agent);
    const outcome = await new Promise<'ok' | 'failed' | 'timeout' | 'cancelled'>((resolve) => {
      let text = '';
      let enterSent = false;
      let done = false;
      const finish = (r: 'ok' | 'failed' | 'timeout' | 'cancelled') => {
        if (done) return;
        done = true;
        this.deps.pty.off('data', onData);
        this.deps.pty.off('exit', onExit);
        clearTimeout(timer);
        if (poll !== null) clearInterval(poll);
        resolve(r);
      };
      const onData = (id: string, data: string) => {
        if (id !== terminalId) return;
        text = (text + data.replace(ANSI, '')).slice(-8000);
        const url = this.runs.get(agent)?.url ?? text.match(URL_IN)?.[0] ?? null;
        const wantsCode = WANTS_CODE.test(text);
        if (url !== this.runs.get(agent)?.url || wantsCode !== this.runs.get(agent)?.wantsCode)
          this.patch(agent, { url, wantsCode });
        if (!enterSent && PRESS_ENTER.test(data.replace(ANSI, ''))) {
          enterSent = true;
          this.deps.terminals.input(terminalId, '\r');
        }
      };
      const onExit = (id: string, exitCode: number) => {
        if (id !== terminalId) return;
        finish(exitCode === 0 ? 'ok' : 'failed');
      };
      this.deps.pty.on('data', onData);
      this.deps.pty.on('exit', onExit);
      const timer = setTimeout(
        () => {
          this.deps.terminals.kill(terminalId);
          finish('timeout');
        },
        this.deps.signinTimeoutMs ?? 10 * 60_000,
      );
      // Gemini stays open after signing in: its saved login is the signal, then it is closed.
      const creds = join(this.deps.home, '.gemini', 'oauth_creds.json');
      const poll =
        agent === 'gemini'
          ? setInterval(() => {
              try {
                if (existsSync(creds) && statSync(creds).mtimeMs >= started - 1000) {
                  this.deps.terminals.kill(terminalId);
                  finish('ok');
                }
              } catch {
                // Not there yet.
              }
            }, this.deps.pollMs ?? 1000)
          : null;
      // Cancelling while the browser is open also closes the sign-in; the run's own cancel is restored after.
      this.cancels.set(agent, () => {
        runCancel?.();
        this.deps.terminals.kill(terminalId);
        finish('cancelled');
      });
    });
    if (runCancel !== undefined) this.cancels.set(agent, runCancel);
    if (outcome === 'cancelled') throw new Cancelled();
    guard();
    this.patch(agent, { status: 'running', wantsCode: false });
    if (outcome === 'timeout') throw new StepFailed('signin', copy.agentSetup.problems.signinTimeout);
    // A sign-in that exited non-zero may still have signed in (verify decides); the caller checks.
  }

  /** Gemini asks how to sign in on its first run; "Login with Google" is preselected unless one is already chosen. */
  private preselectGoogleLogin(): void {
    const dir = join(this.deps.home, '.gemini');
    const file = join(dir, 'settings.json');
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      // No settings yet (or unreadable): start from empty, keeping nothing we could not parse is safer than guessing.
      if (existsSync(file)) return;
    }
    const security = (settings['security'] ?? {}) as Record<string, unknown>;
    const auth = (security['auth'] ?? {}) as Record<string, unknown>;
    if (typeof auth['selectedType'] === 'string') return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({ ...settings, security: { ...security, auth: { ...auth, selectedType: 'oauth-personal' } } }, null, 2)}\n`,
    );
  }

  private async test(agent: SetupAgent, cli: CliInstall, guard: () => void): Promise<void> {
    const product = copy.agentProducts[agent];
    const binary = cli.binary;
    if (binary === null)
      throw new StepFailed('test-failed', fill(copy.agentSetup.problems.test, { product }));
    const cwd = mkdtempSync(join(tmpdir(), 'styx-agent-test-'));
    const started = this.deps.clock.now();
    const r = await this.deps.exec(binary, TEST_ARGS[agent], { cwd, timeoutMs: TEST_TIMEOUT_MS });
    guard();
    if (testAnswered(agent, r.stdout, r.exitCode)) {
      this.patch(agent, { testedMs: this.deps.clock.now() - started });
      return;
    }
    const problem = r.timedOut ? 'test-failed' : classifyTestFailure(`${r.stdout}\n${r.stderr}`);
    const p = copy.agentSetup.problems;
    const message =
      problem === 'out-of-date'
        ? fill(p.outOfDate, { product })
        : problem === 'signin'
          ? fill(p.signedOutAtTest, { product })
          : problem === 'needs-plan'
            ? fill(p.needsPlan, { product, plan: PLAN_NAMES[agent] })
            : problem === 'limit'
              ? p.limit
              : fill(p.test, { product });
    throw new StepFailed(problem, message);
  }

  // --- helpers -----------------------------------------------------------------

  private async hasNpm(): Promise<boolean> {
    if (this.deps.node.installed()) return true;
    return findOnPath('npm', await this.deps.loginPath(), this.deps.platform) !== null;
  }

  private exitOf(terminalId: string): Promise<number> {
    return new Promise((resolve) => {
      const onExit = (id: string, code: number) => {
        if (id !== terminalId) return;
        this.deps.pty.off('exit', onExit);
        resolve(code);
      };
      this.deps.pty.on('exit', onExit);
    });
  }

  private set(agent: SetupAgent, run: AgentSetup): void {
    this.runs.set(agent, run);
    this.deps.publisher.agentSetupSet(run);
  }

  private patch(agent: SetupAgent, change: Partial<AgentSetup> & { step?: SetupStep }): void {
    const cur = this.runs.get(agent);
    if (cur === undefined) return;
    this.set(agent, { ...cur, ...change, updatedAt: this.deps.clock.now() });
  }
}

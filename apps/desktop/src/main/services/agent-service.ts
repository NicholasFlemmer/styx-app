import { copy, type Agent, type CliInstall } from '@styx/core';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import { fail } from '../ipc/bus';
import type { Publisher } from '../store/publisher';
import { logger } from './logger';
import type { PtyService } from './pty-service';
import type { TerminalService } from './terminal-service';

export interface AgentServiceDeps {
  repos: Repos;
  publisher: Publisher;
  clock: Clock;
  terminals: Pick<TerminalService, 'spawnCommand'>;
  pty: Pick<PtyService, 'on' | 'off'>;
  /** Runs a CLI status command (`claude auth status --json` …); injectable so tests never spawn the real CLI. */
  exec: (bin: string, args: string[]) => Promise<{ stdout: string; exitCode: number }>;
  openExternal: (url: string) => Promise<void>;
  home: string;
  env: NodeJS.ProcessEnv;
}

type ConnectableAgent = Exclude<Agent, 'shell'>;

/** The CLI's own sign-in: `claude auth login`, `codex login`, `agent login`; Gemini signs in on its first run. */
const LOGIN_ARGS: Record<ConnectableAgent, string[]> = {
  claude: ['auth', 'login'],
  codex: ['login'],
  cursor: ['login'],
  gemini: [],
};

/** Who the CLI says it is signed in as. Gemini has no status command (see `probeGemini`). */
const STATUS_ARGS: Record<Exclude<ConnectableAgent, 'gemini'>, string[]> = {
  claude: ['auth', 'status', '--json'],
  codex: ['login', 'status'],
  cursor: ['status'],
};

const INSTALL_GUIDES: Record<ConnectableAgent, string> = {
  claude: 'https://docs.claude.com/en/docs/claude-code/setup',
  codex: 'https://github.com/openai/codex',
  gemini: 'https://github.com/google-gemini/gemini-cli',
  cursor: 'https://cursor.com/docs/cli',
};

/** What a status probe learned. `account` is an identity label (email, "ChatGPT", "API key"), never a credential. */
interface Probe {
  authState: 'signed-in' | 'signed-out';
  account: string | null;
}

const SIGNED_OUT: Probe = { authState: 'signed-out', account: null };

/** `claude auth status --json`: only the identity fields are read; everything else in the object is ignored. */
const claudeStatusSchema = z
  .object({
    loggedIn: z.boolean(),
    email: z.string().nullish(),
    authMethod: z.string().nullish(),
  })
  .passthrough();

const geminiAccountsSchema = z.object({ active: z.string().nullish() }).passthrough();

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;

/** The JSON object inside a CLI's output (`exec` appends stderr after stdout, so the object may not be the whole text). */
const parseJsonObject = (text: string): unknown => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON object in the status output');
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    // Node's parse error quotes the input; the row stores a fixed message, never CLI output.
    throw new Error('the status output is not valid JSON');
  }
};

const parseClaude = (stdout: string): Probe => {
  const r = claudeStatusSchema.safeParse(parseJsonObject(stdout));
  if (!r.success) throw new Error('unexpected `claude auth status` output');
  if (!r.data.loggedIn) return SIGNED_OUT;
  return { authState: 'signed-in', account: r.data.email ?? r.data.authMethod ?? null };
};

const parseCodex = (stdout: string): Probe => {
  if (/not logged in/i.test(stdout)) return SIGNED_OUT;
  if (!/logged in/i.test(stdout)) throw new Error('unexpected `codex login status` output');
  // Only fixed labels reach the row: an unrecognised sign-in method shows as signed in with no account name.
  const account = /chatgpt/i.test(stdout) ? 'ChatGPT' : /api key/i.test(stdout) ? 'API key' : null;
  return { authState: 'signed-in', account };
};

const parseCursor = (stdout: string): Probe => {
  if (/not (logged in|authenticated)/i.test(stdout)) return SIGNED_OUT;
  if (!/logged in|authenticated/i.test(stdout)) throw new Error('unexpected `agent status` output');
  return { authState: 'signed-in', account: stdout.match(EMAIL)?.[0] ?? null };
};

/**
 * Agent connections (Settings › App › Agents): verifies who each CLI is signed in as through the CLI's own status
 * command, runs its sign-in in a pty the renderer attaches to, and opens its install guide. Only identity labels
 * are stored (`account`); tokens stay with the CLI and never cross this service.
 */
export class AgentService {
  constructor(private readonly deps: AgentServiceDeps) {}

  /**
   * Re-checks one CLI's sign-in and persists `account` / `verifiedAt` / `verifyError`. Not-installed rows come back
   * unchanged (nothing to ask); an exec failure or unparsable output keeps the previous auth state and records the
   * message so the page can say "check failed" instead of guessing.
   */
  async verify(agent: Agent): Promise<CliInstall> {
    const { repos, publisher, clock } = this.deps;
    const row = repos.discovery.cli(agent) ?? this.undetected(agent);
    if (agent === 'shell') return { ...row, authState: 'n/a' };
    if (!row.found || row.binary === null) return row;
    let next: CliInstall;
    try {
      const probe = await this.probe(agent, row.binary);
      next = { ...row, authState: probe.authState, account: probe.account, verifyError: null };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.warn('agent: verify failed', { agent, error: message });
      next = { ...row, verifyError: message };
    }
    next = { ...next, verifiedAt: clock.now() };
    repos.discovery.saveCli(next);
    publisher.discoverySet(repos.discovery.ides(), repos.discovery.clis());
    return next;
  }

  /**
   * Runs the CLI's own sign-in in a pty the renderer attaches to over the `pty` channel; `agent.login` reports
   * `running` now and `exited` with the exit code when the CLI returns, after which the row is re-verified.
   */
  async login(agent: Agent): Promise<{ terminalId: string; command: string }> {
    if (agent === 'shell') fail('invalid-input', copy.agentsPage.connect.shell);
    const row = this.deps.repos.discovery.cli(agent);
    if (row === null || !row.found || row.binary === null)
      fail('cli-missing', `${copy.agentProducts[agent]} CLI not found on PATH`);
    const binary = row.binary;
    const args = LOGIN_ARGS[agent];
    const terminalId = await this.deps.terminals
      .spawnCommand({ file: binary, args, cwd: this.deps.home })
      .catch((e: Error) => fail('internal', `could not start ${basename(binary)}: ${e.message}`));
    const { publisher, pty } = this.deps;
    const onExit = (id: string, exitCode: number) => {
      if (id !== terminalId) return;
      pty.off('exit', onExit);
      publisher.sendEvent('agent.login', { terminalId, agent, status: 'exited', exitCode });
      void this.verify(agent).catch((e: Error) =>
        logger.warn('agent: verify after login failed', { agent, error: e.message }),
      );
    };
    pty.on('exit', onExit);
    logger.info('agent: login started', { agent, bin: basename(binary), args, terminalId });
    publisher.sendEvent('agent.login', { terminalId, agent, status: 'running' });
    return { terminalId, command: [basename(binary), ...args].join(' ') };
  }

  /** Opens the CLI's install documentation in the OS browser. */
  async installGuide(agent: Agent): Promise<void> {
    if (agent === 'shell') fail('invalid-input', copy.agentsPage.connect.shell);
    await this.deps.openExternal(INSTALL_GUIDES[agent]);
  }

  private async probe(agent: ConnectableAgent, binary: string): Promise<Probe> {
    if (agent === 'gemini') return this.probeGemini();
    const r = await this.deps.exec(binary, STATUS_ARGS[agent]);
    if (r.exitCode !== 0) return SIGNED_OUT;
    switch (agent) {
      case 'claude':
        return parseClaude(r.stdout);
      case 'codex':
        return parseCodex(r.stdout);
      case 'cursor':
        return parseCursor(r.stdout);
    }
  }

  /**
   * Gemini CLI has no status command: it is signed in when its OAuth credentials file exists or `GEMINI_API_KEY`
   * is set; the active Google account (an email) sits in `google_accounts.json` when it signed in with Google.
   */
  private probeGemini(): Probe {
    const dir = join(this.deps.home, '.gemini');
    const oauth = existsSync(join(dir, 'oauth_creds.json'));
    const apiKey =
      typeof this.deps.env['GEMINI_API_KEY'] === 'string' && this.deps.env['GEMINI_API_KEY'] !== '';
    if (!oauth && !apiKey) return SIGNED_OUT;
    let account: string | null = null;
    const accountsFile = join(dir, 'google_accounts.json');
    if (existsSync(accountsFile)) {
      try {
        const r = geminiAccountsSchema.safeParse(JSON.parse(readFileSync(accountsFile, 'utf8')) as unknown);
        if (r.success && typeof r.data.active === 'string' && r.data.active !== '') account = r.data.active;
      } catch {
        account = null;
      }
    }
    if (account === null && !oauth && apiKey) account = 'API key';
    return { authState: 'signed-in', account };
  }

  /** A CLI nothing has detected yet: a not-installed row that is returned, never saved. */
  private undetected(agent: Agent): CliInstall {
    return {
      agent,
      binary: null,
      version: null,
      found: false,
      authState: agent === 'shell' ? 'n/a' : 'unknown',
      capabilities: {},
      checkedAt: this.deps.clock.now(),
      account: null,
      verifiedAt: null,
      verifyError: null,
    };
  }
}

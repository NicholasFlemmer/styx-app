import {
  copy,
  fill,
  installRecipes,
  type Agent,
  type CliInstall,
  type InstallRecipe,
  type ModelInfo,
} from '@styx/core';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import { fail } from '../ipc/bus';
import type { Publisher } from '../store/publisher';
import type { ActivityService } from './activity-service';
import { probeCodexAppServer, type AppServerIdentity } from './app-server-client';
import { findOnPath } from './detect-service';
import { logger } from './logger';
import type { PtyService } from './pty-service';
import type { TerminalService } from './terminal-service';

export interface AgentServiceDeps {
  repos: Repos;
  publisher: Publisher;
  clock: Clock;
  terminals: Pick<TerminalService, 'spawnCommand'>;
  pty: Pick<PtyService, 'on' | 'off'>;
  /**
   * Runs a CLI status command (`claude auth status --json` …); injectable so tests never spawn the real CLI. A
   * runner that keeps stderr apart may hand it over separately; the parsers read both (Codex prints its status
   * on stderr).
   */
  exec: (bin: string, args: string[]) => Promise<{ stdout: string; stderr?: string; exitCode: number }>;
  /**
   * Codex identity through `codex app-server` (`account/read` + `model/list`); null when that build has no working
   * app-server, in which case `codex login status` is asked instead. Injectable so tests never spawn it.
   */
  appServer?: (bin: string) => Promise<AppServerIdentity | null>;
  openExternal: (url: string) => Promise<void>;
  home: string;
  env: NodeJS.ProcessEnv;
  /** Install from the modal (#98): the platform picks the recipe, the login PATH says which tools it may need. */
  platform: NodeJS.Platform;
  loginPath: () => Promise<string>;
  /** The user's login shell (`-ilc <command>`), so `brew` / `npm` resolve as they do in a terminal. */
  shell: () => string;
  /** Re-detects every CLI once an installer exits, before the row is re-verified. */
  refreshClis: () => Promise<unknown>;
  activity: ActivityService;
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

/**
 * What a status probe learned. `account` is an identity label (email, "ChatGPT", "API key"), never a credential.
 * `models` is the CLI's own catalogue when the probe could ask for one (Codex app-server).
 */
interface Probe {
  authState: 'signed-in' | 'signed-out';
  account: string | null;
  models?: ModelInfo[];
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

/** `codex login status` prints "Logged in using ChatGPT" on **stderr** (codex 0.154.0); `text` is stdout + stderr. */
const parseCodex = (text: string): Probe => {
  if (/not logged in/i.test(text)) return SIGNED_OUT;
  if (!/logged in/i.test(text)) throw new Error('unexpected `codex login status` output');
  // Only fixed labels reach the row: an unrecognised sign-in method shows as signed in with no account name.
  const account = /chatgpt/i.test(text) ? 'ChatGPT' : /api key/i.test(text) ? 'API key' : null;
  return { authState: 'signed-in', account };
};

const parseCursor = (stdout: string): Probe => {
  if (/not (logged in|authenticated)/i.test(stdout)) return SIGNED_OUT;
  if (!/logged in|authenticated/i.test(stdout)) throw new Error('unexpected `agent status` output');
  return { authState: 'signed-in', account: stdout.match(EMAIL)?.[0] ?? null };
};

/**
 * Agent connections (Settings › App › Agents): verifies who each CLI is signed in as through the CLI's own status
 * command (Codex: its app-server's `account/read`, which also yields the model catalogue), runs its sign-in in a
 * pty the renderer attaches to, and opens its install guide. Only identity labels are stored (`account`); tokens
 * stay with the CLI and never cross this service.
 */
export class AgentService {
  private readonly appServer: (bin: string) => Promise<AppServerIdentity | null>;

  constructor(private readonly deps: AgentServiceDeps) {
    this.appServer = deps.appServer ?? ((bin) => probeCodexAppServer(bin, { env: deps.env }));
  }

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
      const probe = await this.probe(agent, row.binary, row.capabilities);
      next = {
        ...row,
        authState: probe.authState,
        account: probe.account,
        verifyError: null,
        // The CLI's own model list rides on the row so the composer's pickers fit the agent (same key the
        // session `catalogue` effect writes).
        ...(probe.models !== undefined
          ? { capabilities: { ...row.capabilities, models: probe.models } }
          : {}),
      };
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

  /**
   * Installs a CLI that is not on the machine with the vendor's own documented command (core `installRecipes`:
   * the native installer where one exists, else Homebrew or npm when the login shell has them), in a pty the
   * renderer attaches to. The command is a constant chosen by agent and platform — nothing from the renderer is
   * interpolated — and it runs in the user's login shell so the installer edits the same rc file a terminal would.
   * On exit the CLIs are re-detected (the new binary is found in its install folder before any PATH edit takes
   * effect), the row is re-verified, and only then does `agent.install` report `exited`.
   */
  async install(agent: Agent): Promise<{ terminalId: string; command: string }> {
    if (agent === 'shell') fail('invalid-input', copy.agentsPage.connect.shell);
    const product = copy.agentProducts[agent];
    const row = this.deps.repos.discovery.cli(agent);
    if (row !== null && row.found && row.binary !== null)
      fail('invalid-transition', `${product} is already installed (${row.binary})`);
    const recipe = await this.pickRecipe(agent);
    if (recipe === null) fail('not-found', fill(copy.agentsPage.connect.installNone, { cli: product }));
    const spawn =
      recipe.shell === 'powershell'
        ? {
            file: findOnPath('powershell', await this.deps.loginPath(), 'win32') ?? 'powershell.exe',
            args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', recipe.command],
          }
        : { file: this.deps.shell(), args: ['-ilc', recipe.command] };
    const terminalId = await this.deps.terminals
      .spawnCommand({ ...spawn, cwd: this.deps.home })
      .catch((e: Error) => fail('internal', `could not start the ${product} installer: ${e.message}`));
    const { publisher, pty } = this.deps;
    const onExit = (id: string, exitCode: number) => {
      if (id !== terminalId) return;
      pty.off('exit', onExit);
      void this.afterInstall(agent, recipe, exitCode)
        .catch((e: Error) =>
          logger.warn('agent: re-detect after install failed', { agent, error: e.message }),
        )
        .finally(() =>
          publisher.sendEvent('agent.install', { terminalId, agent, status: 'exited', exitCode }),
        );
    };
    pty.on('exit', onExit);
    logger.info('agent: install started', { agent, command: recipe.command, terminalId });
    publisher.sendEvent('agent.install', { terminalId, agent, status: 'running' });
    return { terminalId, command: recipe.command };
  }

  /** The first recipe for this platform whose required tool the login shell has; null when none applies. */
  private async pickRecipe(agent: Exclude<Agent, 'shell'>): Promise<InstallRecipe | null> {
    const recipes = installRecipes(agent, this.deps.platform);
    if (recipes.length === 0) return null;
    const path = await this.deps.loginPath();
    for (const r of recipes) {
      if (r.requires === null || findOnPath(r.requires, path, this.deps.platform) !== null) return r;
    }
    return null;
  }

  private async afterInstall(
    agent: Exclude<Agent, 'shell'>,
    recipe: InstallRecipe,
    exitCode: number,
  ): Promise<void> {
    await this.deps.refreshClis();
    const row = this.deps.repos.discovery.cli(agent);
    if (exitCode === 0 && row !== null && row.found) {
      this.deps.activity.append({
        who: 'you',
        what: `${copy.agentProducts[agent]} · installed (${recipe.command})`,
        projectId: null,
        sessionId: null,
      });
      await this.verify(agent);
    }
  }

  /** Opens the CLI's install documentation in the OS browser. */
  async installGuide(agent: Agent): Promise<void> {
    if (agent === 'shell') fail('invalid-input', copy.agentsPage.connect.shell);
    await this.deps.openExternal(INSTALL_GUIDES[agent]);
  }

  private async probe(
    agent: ConnectableAgent,
    binary: string,
    capabilities: CliInstall['capabilities'],
  ): Promise<Probe> {
    if (agent === 'gemini') return this.probeGemini();
    if (agent === 'codex' && capabilities['appServer'] === true) {
      // ADR-0016: the app-server names the account (email · plan) and the models; an older build without one
      // (probe → null) is asked the old way below.
      const identity = await this.appServer(binary);
      if (identity !== null) return identity;
    }
    const r = await this.deps.exec(binary, STATUS_ARGS[agent]);
    if (r.exitCode !== 0) return SIGNED_OUT;
    const text = r.stderr !== undefined && r.stderr !== '' ? `${r.stdout}\n${r.stderr}` : r.stdout;
    switch (agent) {
      case 'claude':
        return parseClaude(text);
      case 'codex':
        return parseCodex(text);
      case 'cursor':
        return parseCursor(text);
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

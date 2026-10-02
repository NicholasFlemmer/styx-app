import { execa } from 'execa';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { findOnPath } from '../services/detect-service';
import { logger } from '../services/logger';

export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The binary is not on the login-shell PATH. */
  missing: boolean;
}

export interface CliRunOptions {
  env?: Record<string, string>;
  timeoutMs?: number;
  cwd?: string;
}

/**
 * Runs provider CLIs (`gcloud`, `aws`, `gh`, `vercel`, `supabase`) for the `cli` auth mode. Output is returned to the
 * adapter and nowhere else: results are never logged (they carry tokens), only the binary, argv and exit code are.
 */
export interface CliRunner {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  /** Absolute path of `bin` on the login-shell PATH, or null. */
  which(bin: string): Promise<string | null>;
  run(bin: string, args: string[], opts?: CliRunOptions): Promise<CliRunResult>;
  /** utf8 contents, or null when missing/unreadable. Callers treat the contents as secret. */
  readFile(path: string): Promise<string | null>;
  /** A CLI's own OS-keyring entry (go-keyring layout), or null. Never logged. */
  readKeychain(service: string, account: string): Promise<string | null>;
  /** The login shell's PATH (GUI apps on macOS get a stripped one). */
  loginPath(): Promise<string>;
}

export const DEFAULT_CLI_TIMEOUT_MS = 20_000;

/**
 * Provider credentials that may sit in Electron's own environment (a dev shell with `GH_TOKEN`, a CI runner): they
 * would make the CLI answer with the env token instead of its login, so they never reach a child.
 */
/** Provider/agent token variables never inherited by CLI or login-terminal processes (a dev shell's GH_TOKEN would hijack `gh auth login`). */
export const STRIPPED_ENV = new Set([
  'ELECTRON_RUN_AS_NODE',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'CLOUDSDK_AUTH_ACCESS_TOKEN',
  'GOOGLE_OAUTH_ACCESS_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'VERCEL_TOKEN',
  'SUPABASE_ACCESS_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
]);

/** Non-interactive defaults so a CLI never waits on a prompt Styx cannot answer. */
const QUIET_ENV: Record<string, string> = {
  NO_COLOR: '1',
  CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
  AWS_PAGER: '',
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  CI: '1',
};

export interface ExecaCliRunnerOptions {
  loginPath: () => Promise<string>;
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

export class ExecaCliRunner implements CliRunner {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  private readonly resolved = new Map<string, string | null>();

  constructor(private readonly opts: ExecaCliRunnerOptions) {
    this.platform = opts.platform ?? process.platform;
    this.home = opts.home ?? homedir();
    this.env = opts.env ?? process.env;
  }

  loginPath(): Promise<string> {
    return this.opts.loginPath();
  }

  async which(bin: string): Promise<string | null> {
    const cached = this.resolved.get(bin);
    if (cached !== undefined && cached !== null) return cached;
    const found = findOnPath(bin, await this.loginPath(), this.platform);
    this.resolved.set(bin, found);
    return found;
  }

  async run(bin: string, args: string[], opts: CliRunOptions = {}): Promise<CliRunResult> {
    const file = await this.which(bin);
    if (!file)
      return {
        exitCode: 127,
        stdout: '',
        stderr: `${bin} not found on PATH`,
        timedOut: false,
        missing: true,
      };
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.env)) if (v !== undefined && !STRIPPED_ENV.has(k)) env[k] = v;
    Object.assign(env, QUIET_ENV, { PATH: await this.loginPath() }, opts.env ?? {});
    const r = await execa(file, args, {
      reject: false,
      timeout: opts.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS,
      env,
      extendEnv: false,
      stdin: 'ignore',
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    const exitCode = r.exitCode ?? (r.timedOut ? 124 : 1);
    // argv only: account names and flags, never stdout/stderr (tokens live there).
    logger.debug('cli: ran', { bin, args, exitCode, timedOut: r.timedOut === true });
    return {
      exitCode,
      stdout: String(r.stdout ?? ''),
      stderr: String(r.stderr ?? ''),
      timedOut: r.timedOut === true,
      missing: false,
    };
  }

  async readFile(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  }

  async readKeychain(service: string, account: string): Promise<string | null> {
    try {
      const { Entry } = (await import('@napi-rs/keyring')) as unknown as {
        Entry: new (service: string, account: string) => { getPassword(): string | null };
      };
      return new Entry(service, account).getPassword();
    } catch {
      return null;
    }
  }
}

export interface FakeCliResponse extends Partial<CliRunResult> {
  /** Matched against `bin` and a prefix of `args` (all given args must equal the call's leading args). */
  bin: string;
  args?: string[];
}

const fakeKey = (path: string): string => path.replace(/\\/g, '/');

/** Scriptable runner for tests: binaries on a fake PATH, canned outputs per (bin, args prefix), files by path. */
export class FakeCliRunner implements CliRunner {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly binaries = new Map<string, string>();
  readonly files = new Map<string, string>();
  readonly keychain = new Map<string, string>();
  readonly calls: { bin: string; args: string[]; env?: Record<string, string> | undefined }[] = [];
  private readonly responses: FakeCliResponse[] = [];

  constructor(opts: { platform?: NodeJS.Platform; home?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.platform = opts.platform ?? 'darwin';
    this.home = opts.home ?? '/Users/test';
    this.env = opts.env ?? {};
  }

  install(bin: string, path = `/usr/local/bin/${bin}`): this {
    this.binaries.set(bin, path);
    return this;
  }

  /** Later registrations win, so a test can override a default for one call. */
  on(bin: string, args: string[], result: Partial<CliRunResult>): this {
    this.responses.unshift({ bin, args, ...result });
    return this;
  }

  /** Paths are keyed with `/` separators, so a fixture written as `/Users/test/...` still matches what an adapter
   * builds with `path.join` when the suite runs on a Windows host. */
  file(path: string, contents: string): this {
    this.files.set(fakeKey(path), contents);
    return this;
  }

  async loginPath(): Promise<string> {
    return '/usr/local/bin:/usr/bin';
  }

  async which(bin: string): Promise<string | null> {
    return this.binaries.get(bin) ?? null;
  }

  async run(bin: string, args: string[], opts: CliRunOptions = {}): Promise<CliRunResult> {
    this.calls.push({ bin, args, env: opts.env });
    if (!this.binaries.has(bin))
      return {
        exitCode: 127,
        stdout: '',
        stderr: `${bin} not found on PATH`,
        timedOut: false,
        missing: true,
      };
    const hit = this.responses.find((r) => r.bin === bin && (r.args ?? []).every((a, i) => args[i] === a));
    if (!hit)
      return {
        exitCode: 1,
        stdout: '',
        stderr: `no fake response for ${bin} ${args.join(' ')}`,
        timedOut: false,
        missing: false,
      };
    return {
      exitCode: hit.exitCode ?? 0,
      stdout: hit.stdout ?? '',
      stderr: hit.stderr ?? '',
      timedOut: hit.timedOut ?? false,
      missing: false,
    };
  }

  async readFile(path: string): Promise<string | null> {
    return this.files.get(fakeKey(path)) ?? null;
  }

  async readKeychain(service: string, account: string): Promise<string | null> {
    return this.keychain.get(`${service}\u0000${account}`) ?? null;
  }
}

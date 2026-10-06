import type { CredentialVault } from '../services/credential-vault';
import type { CliRunner } from './cli-runner';

export type Provider = 'vercel' | 'aws' | 'gcp' | 'supabase' | 'github' | 'ssh';
export type Scope = 'read' | 'write' | 'deploy' | 'delete';
export type Env = 'prod' | 'staging' | 'preview' | 'scm';

export interface TargetInfo {
  id: string;
  provider: Provider;
  name: string;
  env: Env;
  config: Record<string, unknown>;
  credentialRef: string | null;
}

export interface GrantInfo {
  id: string;
  scope: Scope[];
  duration: 'once' | '1h' | 'session' | 'always';
  expiresAt: number | null;
}

export type ConnectInput =
  | { method: 'token'; token: string; name?: string; config?: Record<string, unknown> }
  /**
   * Reuse the login the provider's own CLI holds (`gcloud auth list` account, `aws` profile, `gh` login, the
   * `vercel` / `supabase` CLI token). Nothing secret is stored: the vault entry names the account and the CLI
   * mints on every grant.
   */
  | { method: 'cli'; account: string; name?: string; config?: Record<string, unknown> }
  | {
      method: 'device';
      onCode: (code: { userCode: string; verificationUri: string }) => void;
      abort?: AbortSignal;
    }
  | {
      method: 'key';
      accessKeyId: string;
      secretAccessKey: string;
      region?: string;
      roleArn?: string;
      name?: string;
    }
  | { method: 'service-account'; json: string; projectId?: string }
  | { method: 'ssh'; host: string; user: string; keyPath: string; port?: number; passphrase?: string };

export type IssuedCredential =
  | { kind: 'env'; env: Record<string, string>; expiresAt: number | null; scoped: boolean; handle?: string }
  | {
      kind: 'ssh-agent';
      socketPath: string;
      env: Record<string, string>;
      expiresAt: number | null;
      scoped: boolean;
      handle: string;
    };

export type TestResult = { ok: true; identity: string } | { ok: false; error: string };

/**
 * Periodic health probe (RefreshScheduler). `expired: true` means minting actually failed for an auth reason
 * (SSO session over, token revoked, CLI logged out) and the target should show the auth-expired banner;
 * `expired: false` is transient (CLI missing, timeout, network) and leaves the row alone.
 */
export type HealthResult = { ok: true; identity: string } | { ok: false; expired: boolean; error: string };

/** What the provider's CLI currently knows (`target.connect.cliStatus`); identities only, never tokens. */
export interface CliStatus {
  installed: boolean;
  binary: string | null;
  version: string | null;
  loginCommand: string;
  accounts: { id: string; label: string; active: boolean; detail?: string }[];
}

/** A login command Styx runs in a terminal the user can see (`target.connect.cliLogin`). */
export interface CliCommand {
  bin: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ProviderAdapter {
  readonly provider: Provider;
  /** The Advanced (non-CLI) method this adapter's `connect` accepts; `cli` mode is available when `cliStatus` exists. */
  readonly authMethod: 'oauth' | 'key' | 'ssh';
  /** Stores the secret in the vault; returns the ref plus non-secret config and a display label. */
  connect(
    input: ConnectInput,
    targetId: string,
  ): Promise<{ credentialRef: string; config: Record<string, unknown>; label: string }>;
  test(target: TargetInfo): Promise<TestResult>;
  /** Scoped short-lived credential where the provider supports it, else the stored token as env (scoped: false). */
  issue(grant: GrantInfo, target: TargetInfo): Promise<IssuedCredential>;
  revoke(issued: IssuedCredential): Promise<void>;
  /**
   * Maps a shim invocation to the scopes it needs (spec: "Styx enforces scope at the command level"). `tool` is the
   * shim binary that was invoked (`ssh` vs `scp`/`rsync`, `aws` vs `sam`); adapters with one tool may ignore it.
   */
  scopeOfCommand(argv: string[], tool?: string): Scope[];
  /**
   * Whether `issue` for these scopes yields a credential narrower than the stored one. Absent = unscoped (fail
   * closed): GrantService.approve then forces MFA on prod regardless of the classified scope, because the agent
   * receives the full token no matter what the shim heuristics decided.
   */
  issuesScoped?(scope: readonly Scope[], target?: Pick<TargetInfo, 'credentialRef' | 'config'>): boolean;
  /**
   * Which environment a shim command acts on, when the provider's CLI says so without a `--prod` flag (Vercel: a
   * deploy without `--prod` is a preview). Absent or null = unknown, and the broker then treats the command as
   * production when the project has a production target (fail closed): many CLIs (supabase, aws, gcloud) carry no
   * environment in argv, and their credentials often can't be narrowed to one target.
   */
  envOfCommand?(argv: string[], tool?: string): 'prod' | 'non-prod' | null;
  /** Which shim binaries route to this provider. */
  readonly tools: string[];
  /** CLI-first connect: what the local CLI knows (installed, version, accounts). Absent = no CLI mode (SSH). */
  cliStatus?(): Promise<CliStatus>;
  /** The CLI's own login flow for `account` (or a fresh login when omitted); runs in a visible terminal. */
  cliLoginCommand?(account?: string): CliCommand;
  /**
   * The argv that deploys this target. Named by the adapter rather than hard-coded in a service, since only the
   * provider knows how its own environments map onto flags (`--prod` vs a preview build).
   */
  deployCommand?(target: TargetInfo): CliCommand;
  /** Health probe that distinguishes auth expiry from transient failure; falls back to `test()` when absent. */
  health?(target: TargetInfo): Promise<HealthResult>;
}

export type Fetch = typeof fetch;

export interface AdapterDeps {
  vault: CredentialVault;
  fetch: Fetch;
  now: () => number;
  /** Runs provider CLIs on the login-shell PATH; output is never logged. */
  cli: CliRunner;
}

export const HOUR = 3_600_000;

export function expiryFor(grant: GrantInfo, now: number, providerMax = HOUR): number | null {
  if (grant.duration === 'always' || grant.duration === 'session') return grant.expiresAt ?? null;
  const want = grant.expiresAt ?? now + HOUR;
  return Math.min(want, now + providerMax);
}

export function hasVerb(argv: string[], verbs: RegExp): boolean {
  return argv.some((a) => verbs.test(a));
}

/**
 * The command words of an invocation: leading global flags (`--profile x`, `--region=y`) are skipped, then tokens up
 * to the first flag. Read/write classification only ever looks at these, never at flag values, so
 * `aws ssm put-parameter --name list-foo` cannot pass as a read (M2).
 */
export function commandHead(argv: string[]): string[] {
  let i = 0;
  while (i < argv.length && (argv[i] ?? '').startsWith('-'))
    i += (argv[i] ?? '').includes('=') || (argv[i + 1] ?? '-').startsWith('-') ? 1 : 2;
  const head: string[] = [];
  for (; i < argv.length; i += 1) {
    const a = argv[i] ?? '';
    if (a.startsWith('-')) break;
    head.push(a);
  }
  return head;
}

/** `--help` / `--version` / `help` anywhere in argv: no remote effect. */
export function isHelp(argv: string[]): boolean {
  return (
    argv.length === 0 ||
    argv.some((a) => a === '--help' || a === '-h' || a === '--version' || a === '-v') ||
    argv[0] === 'help' ||
    argv[0] === 'version'
  );
}

/**
 * Walks a single-dash short-option cluster (`-iX`, `-sXDELETE`, `-if title=x`, `-Fname=@x`) the way pflag/getopt do:
 * every letter is a flag until a value-taking one (`takesValue`) is hit, whose value is the rest of the arg or, when
 * empty, the next argv token. Returns the value-taking letters seen and the value of the last one. Unknown letters
 * are stepped over so a flag hidden behind a boolean (`-iX`) is never missed (fail closed).
 */
export function shortFlags(
  arg: string,
  next: string | undefined,
  takesValue: string,
): { flags: string[]; value: string | null; consumedNext: boolean } {
  if (!/^-[^-]/.test(arg)) return { flags: [], value: null, consumedNext: false };
  const flags: string[] = [];
  for (let i = 1; i < arg.length; i += 1) {
    const c = arg[i] ?? '';
    if (takesValue.includes(c)) {
      flags.push(c);
      const rest = arg.slice(i + 1);
      if (rest !== '') return { flags, value: rest, consumedNext: false };
      return { flags, value: next ?? '', consumedNext: next !== undefined };
    }
    flags.push(c);
  }
  return { flags, value: null, consumedNext: false };
}

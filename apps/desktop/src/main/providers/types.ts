import type { CredentialVault } from '../services/credential-vault';

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
  | { method: 'device'; onCode: (code: { userCode: string; verificationUri: string }) => void; abort?: AbortSignal }
  | { method: 'key'; accessKeyId: string; secretAccessKey: string; region?: string; roleArn?: string; name?: string }
  | { method: 'service-account'; json: string; projectId?: string }
  | { method: 'ssh'; host: string; user: string; keyPath: string; port?: number; passphrase?: string };

export type IssuedCredential =
  | { kind: 'env'; env: Record<string, string>; expiresAt: number | null; scoped: boolean; handle?: string }
  | { kind: 'ssh-agent'; socketPath: string; env: Record<string, string>; expiresAt: number | null; scoped: boolean; handle: string };

export type TestResult = { ok: true; identity: string } | { ok: false; error: string };

export interface ProviderAdapter {
  readonly provider: Provider;
  readonly authMethod: 'oauth' | 'key' | 'ssh';
  /** Stores the secret in the vault; returns the ref plus non-secret config and a display label. */
  connect(input: ConnectInput, targetId: string): Promise<{ credentialRef: string; config: Record<string, unknown>; label: string }>;
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
  issuesScoped?(scope: readonly Scope[]): boolean;
  /** Which shim binaries route to this provider. */
  readonly tools: string[];
}

export type Fetch = typeof fetch;

export interface AdapterDeps {
  vault: CredentialVault;
  fetch: Fetch;
  now: () => number;
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
  while (i < argv.length && (argv[i] ?? '').startsWith('-')) i += (argv[i] ?? '').includes('=') || (argv[i + 1] ?? '-').startsWith('-') ? 1 : 2;
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
  return argv.length === 0 || argv.some((a) => a === '--help' || a === '-h' || a === '--version' || a === '-v') || argv[0] === 'help' || argv[0] === 'version';
}

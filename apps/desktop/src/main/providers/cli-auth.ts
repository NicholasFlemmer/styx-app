import { join } from 'node:path';
import { z } from 'zod';
import type { CredentialVault } from '../services/credential-vault';
import type { CliRunResult, CliRunner } from './cli-runner';
import type { TargetInfo } from './types';

/**
 * Shared pieces of the `cli` auth mode. The vault entry behind a cli target names an account, never a secret: the
 * provider's CLI owns the credential and mints on every grant.
 */
export const cliVaultEntrySchema = z.object({
  kind: z.literal('cli'),
  account: z.string().min(1),
  profile: z.string().optional(),
  project: z.string().optional(),
});
export type CliVaultEntry = z.infer<typeof cliVaultEntrySchema>;

/** `styx:v1:<provider>:<targetId>:cli` */
export const isCliRef = (ref: string | null): boolean => ref !== null && ref.endsWith(':cli');

/**
 * Minting through the CLI failed. `expired` = the CLI itself says the login is gone (re-auth / SSO session over /
 * logged out): health → `expired` with a Reconnect that reruns the CLI login. Otherwise the failure is transient
 * (binary missing, timeout) and the target keeps its health.
 */
export class CliAuthError extends Error {
  constructor(
    message: string,
    readonly expired: boolean,
  ) {
    super(message);
    this.name = 'CliAuthError';
  }
}

export async function readCliEntry(
  vault: CredentialVault,
  target: TargetInfo,
): Promise<CliVaultEntry | null> {
  if (!isCliRef(target.credentialRef) || !target.credentialRef) return null;
  const raw = await vault.get(target.credentialRef);
  if (!raw) throw new Error('credential missing from keychain');
  const parsed = cliVaultEntrySchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error('cli vault entry is malformed');
  return parsed.data;
}

/** Only trailing whitespace is trimmed: CLIs print tokens followed by a newline. */
export const firstLine = (s: string): string => (s.split(/\r?\n/)[0] ?? '').trim();

/** `installed` / `version` shared by every `cliStatus`. */
export async function cliInstall(
  cli: CliRunner,
  bin: string,
  versionArgs: string[],
  parse: (out: string) => string | null,
): Promise<{ binary: string | null; version: string | null }> {
  const binary = await cli.which(bin);
  if (!binary) return { binary: null, version: null };
  const r = await cli.run(bin, versionArgs, { timeoutMs: 10_000 });
  return { binary, version: r.exitCode === 0 ? parse(`${r.stdout}\n${r.stderr}`) : null };
}

export const semver = (s: string): string | null => /(\d+\.\d+(?:\.\d+)?)/.exec(s)?.[1] ?? null;

/**
 * Diagnostics that mean "the login itself is gone" (gcloud reauth / revoked refresh token, AWS SSO session over or
 * profile missing, gh logged out, 401/403 from the provider API, ssh key refused). Anything else — DNS down after
 * wake, a 5xx, a rate limit, a wrapper printing a banner — is transient and must not raise the Reconnect banner.
 */
const AUTH_FAILURE = [
  /reauth/i,
  /invalid_grant|invalid_rapt|Token has been expired or revoked/i,
  /not logged in|no oauth token|not authenticated|You do not currently have an active account|does not exist in gcloud|no credentialed accounts/i,
  /Error loading SSO Token|SSO session .*expired|Token for .* has expired|The SSO session associated with this profile has expired|ExpiredToken|InvalidClientTokenId|SignatureDoesNotMatch|UnrecognizedClientException/i,
  /could not be found|Unable to locate credentials|Partial credentials found|credentials missing from keychain|credential missing from keychain/i,
  /rejected the token \(40[13]\)|\b401\b|Unauthorized|Bad credentials/i,
  /Permission denied \(publickey|Host key verification failed|is not logged in/i,
];
export const isAuthFailure = (message: string): boolean => AUTH_FAILURE.some((re) => re.test(message));

/**
 * Result → error. Only stderr (the CLI's own diagnostics) is quoted, never stdout: the message reaches audit detail
 * and the banner body, and stdout is where tokens are printed. `expired` only when stderr names an auth failure.
 */
export function cliFailure(bin: string, r: CliRunResult): CliAuthError {
  if (r.missing) return new CliAuthError(`${bin} is not installed`, false);
  if (r.timedOut) return new CliAuthError(`${bin} timed out`, false);
  const detail = firstLine(r.stderr.trim()) || `exit ${r.exitCode}`;
  return new CliAuthError(`${bin}: ${detail}`, isAuthFailure(r.stderr));
}

/** `health()` fallback for the Advanced modes: a `test()` failure is an expiry only when the provider said so. */
export const testToHealth = (
  t: { ok: true; identity: string } | { ok: false; error: string; needsProject?: boolean },
): { ok: true; identity: string } | { ok: false; expired: boolean; error: string } =>
  t.ok
    ? t
    : // A target that only needs its project chosen is never an expiry (no Reconnect banner).
      { ok: false, expired: t.needsProject === true ? false : isAuthFailure(t.error), error: t.error };

/** Accounts / profiles / logins travel into argv: plain charset, first char alphanumeric so none can pose as a flag. */
export const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._@+:/-]{0,127}$/;

// --- aws -------------------------------------------------------------------

export interface AwsProfile {
  name: string;
  region: string | null;
  sso: boolean;
  accountId: string | null;
  roleArn: string | null;
  /** From `~/.aws/credentials` only (static keys) — never the values. */
  static: boolean;
}

/**
 * Profiles from `~/.aws/config` (`[default]`, `[profile x]`; `[sso-session x]` blocks are skipped) plus section
 * names from `~/.aws/credentials`. Values other than region / sso_* / role_arn / sso_account_id are ignored so key
 * material in the credentials file never leaves this function.
 */
export function parseAwsProfiles(config: string | null, credentials: string | null): AwsProfile[] {
  const byName = new Map<string, AwsProfile>();
  const get = (name: string): AwsProfile => {
    let p = byName.get(name);
    if (!p) {
      p = { name, region: null, sso: false, accountId: null, roleArn: null, static: false };
      byName.set(name, p);
    }
    return p;
  };
  let current: AwsProfile | null = null;
  for (const raw of (config ?? '').split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim();
    if (!line) continue;
    const section = /^\[(.+)\]$/.exec(line);
    if (section) {
      const head = (section[1] ?? '').trim();
      if (head === 'default') current = get('default');
      else if (head.startsWith('profile ')) current = get(head.slice('profile '.length).trim());
      else current = null; // sso-session / services / unknown
      continue;
    }
    if (!current) continue;
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = (kv[1] ?? '').toLowerCase();
    const value = (kv[2] ?? '').trim();
    if (key === 'region') current.region = value || null;
    else if (key === 'sso_session' || key === 'sso_start_url') current.sso = true;
    else if (key === 'sso_account_id') current.accountId = value || null;
    else if (key === 'role_arn') current.roleArn = value || null;
  }
  for (const raw of (credentials ?? '').split(/\r?\n/)) {
    const section = /^\s*\[(.+)\]\s*$/.exec(raw);
    if (section) get((section[1] ?? '').trim()).static = true;
  }
  return [...byName.values()];
}

export const awsExportCredentialsSchema = z.object({
  Version: z.number().optional(),
  AccessKeyId: z.string().min(1),
  SecretAccessKey: z.string().min(1),
  SessionToken: z.string().optional(),
  Expiration: z.string().optional(),
});

// --- gh --------------------------------------------------------------------

export interface GhAccount {
  host: string;
  login: string;
  active: boolean;
  ok: boolean;
  scopes: string | null;
}

/**
 * `gh auth status` (text; `--json` only exists in recent releases). Handles the ≥2.40 multi-account layout
 * (`Logged in to github.com account octocat (keyring)` + `Active account: true`) and the older
 * `Logged in to github.com as octocat` form. `Failed to log in …` lines are accounts whose token no longer works.
 */
export function parseGhAuthStatus(text: string): GhAccount[] {
  const out: GhAccount[] = [];
  let last: GhAccount | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const ok = /Logged in to (\S+) (?:account|as) (\S+)/.exec(line);
    const bad = /Failed to log in to (\S+) (?:account|as) (\S+)/.exec(line);
    const m = ok ?? bad;
    if (m) {
      last = {
        host: m[1] ?? 'github.com',
        login: m[2] ?? '',
        active: ok !== null,
        ok: ok !== null,
        scopes: null,
      };
      out.push(last);
      continue;
    }
    if (!last) continue;
    const active = /Active account:\s*(true|false)/i.exec(line);
    if (active) last.active = last.ok && active[1]?.toLowerCase() === 'true';
    const scopes = /Token scopes:\s*(.+)$/.exec(line);
    if (scopes) last.scopes = (scopes[1] ?? '').replace(/'/g, '').trim();
  }
  return out;
}

// --- vercel / supabase file locations --------------------------------------

/** Where `vercel login` keeps its token (`auth.json`, `{ "token": … }`), per platform; read-only for Styx. */
export function vercelAuthPaths(cli: Pick<CliRunner, 'platform' | 'home' | 'env'>): string[] {
  const { platform, home, env } = cli;
  if (platform === 'darwin')
    return [
      join(home, 'Library', 'Application Support', 'com.vercel.cli', 'auth.json'),
      join(home, '.config', 'com.vercel.cli', 'auth.json'),
    ];
  if (platform === 'win32') {
    const appData = env['APPDATA'] ?? join(home, 'AppData', 'Roaming');
    const local = env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local');
    return [
      join(appData, 'vercel', 'auth.json'),
      join(appData, 'com.vercel.cli', 'auth.json'),
      join(local, 'com.vercel.cli', 'auth.json'),
    ];
  }
  const xdg = env['XDG_DATA_HOME'] ?? join(home, '.local', 'share');
  return [join(xdg, 'com.vercel.cli', 'auth.json'), join(home, '.config', 'com.vercel.cli', 'auth.json')];
}

/** `supabase login` writes `~/.supabase/access-token` when no OS keyring is available (else the keyring). */
export const supabaseTokenPath = (cli: Pick<CliRunner, 'home'>): string =>
  join(cli.home, '.supabase', 'access-token');

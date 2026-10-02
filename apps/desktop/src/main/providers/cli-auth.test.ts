import { describe, expect, it } from 'vitest';
import { MemoryVault } from '../services/credential-vault';
import {
  ACCOUNT_PATTERN,
  CliAuthError,
  cliFailure,
  firstLine,
  isAuthFailure,
  isCliRef,
  parseAwsProfiles,
  parseGhAuthStatus,
  readCliEntry,
  supabaseTokenPath,
  vercelAuthPaths,
} from './cli-auth';

describe('cli-auth parsers', () => {
  it('parses ~/.aws/config profiles (default, profile x, sso-session skipped) and credentials section names only', () => {
    const config = [
      '[default]',
      'region = us-east-1',
      '',
      '[profile acme-prod]',
      'sso_session = acme',
      'sso_account_id = 123456789012',
      'sso_role_name = Admin',
      'region = eu-west-1 # comment',
      '',
      '[sso-session acme]',
      'sso_start_url = https://acme.awsapps.com/start',
      'sso_region = eu-west-1',
      '',
      '[profile ci]',
      'role_arn = arn:aws:iam::123:role/ci',
      'source_profile = default',
      '',
      '[profile legacy-sso]',
      'sso_start_url = https://old.awsapps.com/start',
    ].join('\n');
    const credentials =
      '[default]\naws_access_key_id = AKIAFIXTUREFIXTURE1\naws_secret_access_key = FIXTURE\n\n[static-only]\naws_access_key_id = AKIAFIXTUREFIXTURE2\n';
    const out = parseAwsProfiles(config, credentials);
    expect(out).toEqual([
      { name: 'default', region: 'us-east-1', sso: false, accountId: null, roleArn: null, static: true },
      {
        name: 'acme-prod',
        region: 'eu-west-1',
        sso: true,
        accountId: '123456789012',
        roleArn: null,
        static: false,
      },
      {
        name: 'ci',
        region: null,
        sso: false,
        accountId: null,
        roleArn: 'arn:aws:iam::123:role/ci',
        static: false,
      },
      { name: 'legacy-sso', region: null, sso: true, accountId: null, roleArn: null, static: false },
      { name: 'static-only', region: null, sso: false, accountId: null, roleArn: null, static: true },
    ]);
    expect(JSON.stringify(out)).not.toContain('AKIA'); // key material never leaves the parser
    expect(parseAwsProfiles(null, null)).toEqual([]);
  });

  it('parses gh auth status (multi-account ≥2.40, legacy "as", failed logins)', () => {
    const modern = [
      'github.com',
      '  ✓ Logged in to github.com account nic (keyring)',
      '  - Active account: true',
      '  - Git operations protocol: https',
      '  - Token: gho_************************************',
      "  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'",
      '',
      '  ✓ Logged in to github.com account acme-bot (GH_TOKEN)',
      '  - Active account: false',
      '  - Token: ghp_************************************',
      '',
      '  X Failed to log in to github.com account stale (keyring)',
      '  - Active account: false',
      '  - The token in keyring is invalid.',
    ].join('\n');
    expect(parseGhAuthStatus(modern)).toEqual([
      { host: 'github.com', login: 'nic', active: true, ok: true, scopes: 'gist, read:org, repo, workflow' },
      { host: 'github.com', login: 'acme-bot', active: false, ok: true, scopes: null },
      { host: 'github.com', login: 'stale', active: false, ok: false, scopes: null },
    ]);
    const legacy =
      'github.com\n  ✓ Logged in to github.com as nic (keyring)\n  ✓ Git operations for github.com configured to use https protocol.\n  ✓ Token: gho_****\n';
    expect(parseGhAuthStatus(legacy)).toEqual([
      { host: 'github.com', login: 'nic', active: true, ok: true, scopes: null },
    ]);
    expect(
      parseGhAuthStatus('You are not logged into any GitHub hosts. To log in, run: gh auth login'),
    ).toEqual([]);
  });

  it('locates the vercel and supabase CLI stores per platform', () => {
    // POSIX layouts compared with `/` separators: `join` follows the host, so a Windows host builds them with `\\`.
    const slash = (p: string | undefined) => p?.replace(/\\/g, '/');
    expect(slash(vercelAuthPaths({ platform: 'darwin', home: '/Users/nic', env: {} })[0])).toBe(
      '/Users/nic/Library/Application Support/com.vercel.cli/auth.json',
    );
    // `join` follows the host; on a real Windows host this is `…\\Roaming\\vercel\\auth.json`.
    expect(
      vercelAuthPaths({
        platform: 'win32',
        home: 'C:\\Users\\nic',
        env: { APPDATA: 'C:\\Users\\nic\\AppData\\Roaming' },
      })[0],
    ).toMatch(/^C:\\Users\\nic\\AppData\\Roaming[\\/]vercel[\\/]auth\.json$/);
    expect(slash(vercelAuthPaths({ platform: 'linux', home: '/home/nic', env: {} })[0])).toBe(
      '/home/nic/.local/share/com.vercel.cli/auth.json',
    );
    expect(slash(supabaseTokenPath({ home: '/Users/nic' }))).toBe('/Users/nic/.supabase/access-token');
  });

  it('cli vault entries carry an account and never a secret; refs end in :cli', async () => {
    const vault = new MemoryVault();
    await vault.set(
      'styx:v1:gcp:t1:cli',
      JSON.stringify({ kind: 'cli', account: 'nic@acme.dev', project: 'acme-shop' }),
    );
    await vault.set('styx:v1:gcp:t2:key', JSON.stringify({ client_email: 'x', private_key: 'y' }));
    await vault.set('styx:v1:gcp:t3:cli', JSON.stringify({ token: 'nope' }));
    const t = (id: string, ref: string | null) => ({
      id,
      provider: 'gcp' as const,
      name: 'x',
      env: 'prod' as const,
      config: {},
      credentialRef: ref,
    });
    expect(await readCliEntry(vault, t('t1', 'styx:v1:gcp:t1:cli'))).toEqual({
      kind: 'cli',
      account: 'nic@acme.dev',
      project: 'acme-shop',
    });
    expect(await readCliEntry(vault, t('t2', 'styx:v1:gcp:t2:key'))).toBeNull();
    expect(await readCliEntry(vault, t('t0', null))).toBeNull();
    await expect(readCliEntry(vault, t('t3', 'styx:v1:gcp:t3:cli'))).rejects.toThrow(/malformed/);
    await expect(readCliEntry(vault, t('t4', 'styx:v1:gcp:t4:cli'))).rejects.toThrow(/missing from keychain/);
    expect(isCliRef('styx:v1:aws:t:cli')).toBe(true);
    expect(isCliRef('styx:v1:aws:t:key')).toBe(false);
    expect(isCliRef(null)).toBe(false);
  });

  it('isAuthFailure: only the provider saying the login is gone counts; network / 5xx / banners are transient', () => {
    for (const m of [
      'ERROR: (gcloud.auth.print-access-token) There was a problem refreshing your current auth tokens: reauth required',
      'Error loading SSO Token: Token for acme has expired',
      'The SSO session associated with this profile has expired or is otherwise invalid.',
      'no oauth token found for github.com',
      'GitHub rejected the token (401)',
      'Vercel rejected the token (403)',
      'Permission denied (publickey).',
      'credential missing from keychain',
      'The config profile (nope) could not be found',
    ])
      expect(isAuthFailure(m), m).toBe(true);
    for (const m of [
      'Could not connect to the endpoint URL: "https://portal.sso.eu-west-1.amazonaws.com/"',
      'ERROR: gcloud crashed (ConnectionError): HTTPSConnectionPool',
      'GitHub rejected the token (502)',
      'Supabase rejected the token (429)',
      'ssh: connect to host prod-1 port 22: Connection refused',
      'exit 1',
      '',
    ])
      expect(isAuthFailure(m), m).toBe(false);
    expect(ACCOUNT_PATTERN.test('nic@acme.dev')).toBe(true);
    expect(ACCOUNT_PATTERN.test('acme-prod')).toBe(true);
    expect(ACCOUNT_PATTERN.test('--update-adc')).toBe(false);
    expect(ACCOUNT_PATTERN.test('-x')).toBe(false);
    expect(ACCOUNT_PATTERN.test('x; rm')).toBe(false);
  });

  it('cliFailure: missing / timeout / unknown exits are transient, only an auth diagnostic is an expiry; stdout is not echoed', () => {
    const base = { exitCode: 1, stdout: 'ya29.secret-token', stderr: '', timedOut: false, missing: false };
    expect(cliFailure('gcloud', { ...base, missing: true })).toMatchObject({
      expired: false,
      message: 'gcloud is not installed',
    });
    expect(cliFailure('gcloud', { ...base, timedOut: true })).toMatchObject({
      expired: false,
      message: 'gcloud timed out',
    });
    const e = cliFailure('gcloud', { ...base, stderr: 'ERROR: reauth required\nmore' });
    expect(e).toBeInstanceOf(CliAuthError);
    expect(e).toMatchObject({ expired: true, message: 'gcloud: ERROR: reauth required' });
    // stdout never surfaces (that is where tokens are printed), even when stderr is empty; an unexplained exit is transient.
    expect(cliFailure('gcloud', { ...base, exitCode: 3 })).toMatchObject({
      expired: false,
      message: 'gcloud: exit 3',
    });
    expect(cliFailure('aws', { ...base, stderr: 'Could not connect to the endpoint URL' })).toMatchObject({
      expired: false,
    });
    expect(firstLine('tok\nrest')).toBe('tok');
  });
});

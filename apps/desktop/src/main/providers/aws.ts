import { join } from 'node:path';
import { makeCredentialRef } from '../services/credential-vault';
import {
  awsExportCredentialsSchema,
  CliAuthError,
  cliFailure,
  cliInstall,
  firstLine,
  parseAwsProfiles,
  readCliEntry,
  semver,
  testToHealth,
  ACCOUNT_PATTERN,
  type AwsProfile,
} from './cli-auth';
import type {
  AdapterDeps,
  CliCommand,
  CliStatus,
  ConnectInput,
  GrantInfo,
  HealthResult,
  IssuedCredential,
  ProviderAdapter,
  Scope,
  TargetInfo,
  TestResult,
} from './types';
import { commandHead, expiryFor, hasVerb } from './types';

export interface StsLike {
  callerIdentity(creds: AwsKeys): Promise<{ arn: string; account: string }>;
  assumeRole(
    creds: AwsKeys,
    roleArn: string,
    policy: string,
    durationSeconds: number,
    sessionName: string,
  ): Promise<AwsSession>;
  federationToken(creds: AwsKeys, name: string, policy: string, durationSeconds: number): Promise<AwsSession>;
}
/** `sessionToken` is present for temporary credentials (cli mode: SSO / assumed-role profiles). */
export interface AwsKeys {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  sessionToken?: string;
}
export interface AwsSession {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: number;
}

/** Session policy per scope. `read` → Get/List/Describe; `write` → everything except Delete/Terminate; `delete` lifts the deny. */
export function sessionPolicy(scope: Scope[]): string {
  const st: Record<string, unknown>[] = [];
  const s = new Set(scope);
  if (s.has('write') || s.has('deploy') || s.has('delete'))
    st.push({ Effect: 'Allow', Action: '*', Resource: '*' });
  else
    st.push({
      Effect: 'Allow',
      Action: ['*:Get*', '*:List*', '*:Describe*', '*:Head*', 'sts:GetCallerIdentity'],
      Resource: '*',
    });
  if (!s.has('delete'))
    st.push({
      Effect: 'Deny',
      Action: ['*:Delete*', '*:Terminate*', '*:Destroy*', '*:Remove*', 'iam:*'],
      Resource: '*',
    });
  return JSON.stringify({ Version: '2012-10-17', Statement: st });
}

/** Default STS implementation using @aws-sdk/client-sts (loaded lazily). */
export async function defaultSts(): Promise<StsLike> {
  const sdk = await import('@aws-sdk/client-sts');
  const client = (c: AwsKeys) =>
    new sdk.STSClient({
      region: c.region,
      credentials: {
        accessKeyId: c.accessKeyId,
        secretAccessKey: c.secretAccessKey,
        ...(c.sessionToken ? { sessionToken: c.sessionToken } : {}),
      },
    });
  const toSession = (r: {
    Credentials?:
      | {
          AccessKeyId?: string | undefined;
          SecretAccessKey?: string | undefined;
          SessionToken?: string | undefined;
          Expiration?: Date | undefined;
        }
      | undefined;
  }): AwsSession => {
    const c = r.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken)
      throw new Error('STS returned no credentials');
    return {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
      expiration: c.Expiration?.getTime() ?? Date.now() + 3_600_000,
    };
  };
  return {
    callerIdentity: async (c) => {
      const r = await client(c).send(new sdk.GetCallerIdentityCommand({}));
      return { arn: r.Arn ?? '', account: r.Account ?? '' };
    },
    assumeRole: async (c, roleArn, policy, dur, name) =>
      toSession(
        await client(c).send(
          new sdk.AssumeRoleCommand({
            RoleArn: roleArn,
            RoleSessionName: name,
            Policy: policy,
            DurationSeconds: dur,
          }),
        ),
      ),
    federationToken: async (c, name, policy, dur) =>
      toSession(
        await client(c).send(
          new sdk.GetFederationTokenCommand({ Name: name, Policy: policy, DurationSeconds: dur }),
        ),
      ),
  };
}

const PROFILE = ACCOUNT_PATTERN;

/**
 * AWS. Two modes behind one adapter:
 * - `cli` (primary): an `aws` profile (`~/.aws/config`; SSO profiles are the common case). Each grant runs
 *   `aws configure export-credentials --profile <p> --format process` and hands the short-lived credentials over.
 *   With `config.roleArn` they are first narrowed by `sts:AssumeRole` + session policy (scoped:true, role chaining);
 *   without one the profile's own credentials go through as-is (scoped:false → MFA on prod for every scope).
 *   An expired SSO session makes export fail → health `expired`, Reconnect = `aws sso login --profile <p>`.
 * - `key` (Advanced): long-lived keys in the vault; every grant gets STS credentials scoped by a session policy
 *   (AssumeRole with `roleArn`, else GetFederationToken) — scoped:true.
 */
export class AwsAdapter implements ProviderAdapter {
  readonly provider = 'aws' as const;
  readonly authMethod = 'key' as const;
  readonly tools = ['aws', 'sam', 'cdk'];
  constructor(
    private readonly deps: AdapterDeps,
    private readonly sts: () => Promise<StsLike> = defaultSts,
  ) {}

  async connect(input: ConnectInput, targetId: string) {
    if (input.method === 'cli') return this.connectCli(input, targetId);
    if (input.method !== 'key') throw new Error('AWS connect expects an access key or an aws profile');
    const keys: AwsKeys = {
      accessKeyId: input.accessKeyId.trim(),
      secretAccessKey: input.secretAccessKey.trim(),
      region: input.region ?? 'us-east-1',
    };
    const id = await (await this.sts()).callerIdentity(keys);
    const ref = makeCredentialRef('aws', targetId, 'key');
    await this.deps.vault.set(ref, JSON.stringify(keys));
    return {
      credentialRef: ref,
      config: {
        region: keys.region,
        accountId: id.account,
        ...(input.roleArn ? { roleArn: input.roleArn } : {}),
      },
      label: input.name ?? `AWS ${id.account}`,
    };
  }

  // --- cli mode --------------------------------------------------------------

  private async profiles(): Promise<AwsProfile[]> {
    const { cli } = this.deps;
    const config = await cli.readFile(cli.env['AWS_CONFIG_FILE'] ?? join(cli.home, '.aws', 'config'));
    const credentials = await cli.readFile(
      cli.env['AWS_SHARED_CREDENTIALS_FILE'] ?? join(cli.home, '.aws', 'credentials'),
    );
    return parseAwsProfiles(config, credentials);
  }

  /** `aws configure export-credentials --profile <p> --format process` → temporary (or static) credentials. */
  private async exportCredentials(
    profile: string,
    region: string,
  ): Promise<AwsKeys & { expiration: number | null }> {
    if (!PROFILE.test(profile)) throw new CliAuthError('invalid aws profile name', false);
    const r = await this.deps.cli.run(
      'aws',
      ['configure', 'export-credentials', '--profile', profile, '--format', 'process'],
      { env: { AWS_REGION: region } },
    );
    if (r.exitCode !== 0) throw cliFailure('aws', r);
    let json: unknown;
    try {
      json = JSON.parse(r.stdout || '{}');
    } catch {
      // Never quote stdout: a credential_process banner or wrapper output would put key material in the message.
      throw new CliAuthError('aws export-credentials printed no JSON', false);
    }
    const parsed = awsExportCredentialsSchema.safeParse(json);
    if (!parsed.success) throw new CliAuthError('aws export-credentials returned no credentials', false);
    const c = parsed.data;
    const exp = c.Expiration ? Date.parse(c.Expiration) : NaN;
    return {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      region,
      ...(c.SessionToken ? { sessionToken: c.SessionToken } : {}),
      expiration: Number.isFinite(exp) ? exp : null,
    };
  }

  private async connectCli(input: Extract<ConnectInput, { method: 'cli' }>, targetId: string) {
    const profile = input.account.trim();
    const cfg = input.config ?? {};
    const known = (await this.profiles()).find((p) => p.name === profile);
    const region =
      (typeof cfg['region'] === 'string' && cfg['region']) ||
      known?.region ||
      this.deps.cli.env['AWS_DEFAULT_REGION'] ||
      'us-east-1';
    const creds = await this.exportCredentials(profile, region);
    const id = await (await this.sts()).callerIdentity(creds);
    const ref = makeCredentialRef('aws', targetId, 'cli');
    await this.deps.vault.set(ref, JSON.stringify({ kind: 'cli', account: profile, profile }));
    const roleArn = typeof cfg['roleArn'] === 'string' && cfg['roleArn'] ? cfg['roleArn'] : null;
    const config: Record<string, unknown> = {
      ...cfg,
      region,
      accountId: id.account,
      account: profile,
      profile,
      sso: known?.sso ?? false,
      ...(roleArn ? { roleArn } : {}),
    };
    return { credentialRef: ref, config, label: input.name ?? `AWS ${id.account}` };
  }

  async cliStatus(): Promise<CliStatus> {
    const { binary, version } = await cliInstall(this.deps.cli, 'aws', ['--version'], (out) =>
      semver(firstLine(out).replace(/^aws-cli\//, '')),
    );
    if (!binary)
      return {
        installed: false,
        binary: null,
        version: null,
        loginCommand: 'aws configure sso',
        accounts: [],
      };
    const profiles = await this.profiles();
    const accounts = await Promise.all(
      profiles.map(async (p) => {
        const region = p.region ?? this.deps.cli.env['AWS_DEFAULT_REGION'] ?? 'us-east-1';
        const r = await this.deps.cli.run(
          'aws',
          ['configure', 'export-credentials', '--profile', p.name, '--format', 'process'],
          { env: { AWS_REGION: region }, timeoutMs: 15_000 },
        );
        const kind = p.sso ? 'sso' : p.roleArn ? 'role' : p.static ? 'keys' : 'profile';
        const parts = [kind, ...(p.accountId ? [p.accountId] : []), ...(p.region ? [p.region] : [])];
        const ok = r.exitCode === 0;
        return {
          id: p.name,
          label: p.name,
          active: ok,
          detail: ok
            ? parts.join(' · ')
            : `${parts.join(' · ')} · ${p.sso ? 'session expired' : 'credentials unavailable'}`,
        };
      }),
    );
    const firstSso = profiles.find((p) => p.sso);
    const loginCommand = firstSso ? `aws sso login --profile ${firstSso.name}` : 'aws configure sso';
    return { installed: true, binary, version, loginCommand, accounts };
  }

  cliLoginCommand(account?: string): CliCommand {
    if (!account) return { bin: 'aws', args: ['configure', 'sso'] };
    return { bin: 'aws', args: ['sso', 'login', '--profile', account] };
  }

  async health(target: TargetInfo): Promise<HealthResult> {
    const entry = await readCliEntry(this.deps.vault, target).catch((e: Error) => {
      throw new CliAuthError(e.message, false);
    });
    if (!entry) return testToHealth(await this.test(target));
    try {
      await this.exportCredentials(entry.profile ?? entry.account, this.region(target));
      return { ok: true, identity: `profile ${entry.profile ?? entry.account}` };
    } catch (e) {
      return {
        ok: false,
        expired: e instanceof CliAuthError ? e.expired : false,
        error: (e as Error).message,
      };
    }
  }

  private region(target: TargetInfo): string {
    return typeof target.config['region'] === 'string' ? target.config['region'] : 'us-east-1';
  }

  // --- shared ----------------------------------------------------------------

  private async keys(target: TargetInfo): Promise<AwsKeys & { expiration: number | null; cli: boolean }> {
    const entry = await readCliEntry(this.deps.vault, target);
    if (entry)
      return {
        ...(await this.exportCredentials(entry.profile ?? entry.account, this.region(target))),
        cli: true,
      };
    if (!target.credentialRef) throw new Error('not connected');
    const raw = await this.deps.vault.get(target.credentialRef);
    if (!raw) throw new Error('credential missing from keychain');
    return { ...(JSON.parse(raw) as AwsKeys), expiration: null, cli: false };
  }

  async test(target: TargetInfo): Promise<TestResult> {
    try {
      const id = await (await this.sts()).callerIdentity(await this.keys(target));
      return { ok: true, identity: id.arn };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async issue(grant: GrantInfo, target: TargetInfo): Promise<IssuedCredential> {
    const keys = await this.keys(target);
    const sts = await this.sts();
    const now = this.deps.now();
    const expiresAt = expiryFor(grant, now) ?? now + 3_600_000;
    const seconds = Math.max(900, Math.min(3600, Math.floor((expiresAt - now) / 1000)));
    const policy = sessionPolicy(grant.scope);
    const roleArn = target.config['roleArn'];
    const name = `styx-${grant.id.slice(-12)}`;
    const env: Record<string, string> = { AWS_REGION: keys.region, AWS_DEFAULT_REGION: keys.region };
    if (keys.cli && typeof roleArn !== 'string') {
      // The profile's own credentials, as exported: nothing narrower is available without a role to assume.
      env['AWS_ACCESS_KEY_ID'] = keys.accessKeyId;
      env['AWS_SECRET_ACCESS_KEY'] = keys.secretAccessKey;
      if (keys.sessionToken) env['AWS_SESSION_TOKEN'] = keys.sessionToken;
      return {
        kind: 'env',
        env,
        expiresAt: keys.expiration === null ? expiresAt : Math.min(expiresAt, keys.expiration),
        scoped: false,
        handle: 'cli',
      };
    }
    const session =
      typeof roleArn === 'string'
        ? await sts.assumeRole(keys, roleArn, policy, seconds, name)
        : await sts.federationToken(keys, name, policy, seconds);
    env['AWS_ACCESS_KEY_ID'] = session.accessKeyId;
    env['AWS_SECRET_ACCESS_KEY'] = session.secretAccessKey;
    env['AWS_SESSION_TOKEN'] = session.sessionToken;
    return {
      kind: 'env',
      env,
      expiresAt: Math.min(expiresAt, session.expiration),
      scoped: true,
      ...(keys.cli ? { handle: 'cli' } : {}),
    };
  }

  async revoke(): Promise<void> {
    /* STS credentials cannot be revoked early; they are short-lived and no longer delivered */
  }

  issuesScoped(_scope: readonly Scope[], target?: Pick<TargetInfo, 'credentialRef' | 'config'>): boolean {
    // key mode: the STS session policy narrows the long-lived key per grant. cli mode: only with a role to assume.
    if (!target || !target.credentialRef?.endsWith(':cli')) return true;
    return typeof target.config['roleArn'] === 'string' && target.config['roleArn'].length > 0;
  }

  scopeOfCommand(argv: string[]): Scope[] {
    if (
      hasVerb(argv, /^(delete-|terminate-|remove-|destroy|rb$|rm$)/) ||
      (argv[0] === 's3' && argv[1] === 'rm') ||
      (argv[0] === 'cloudformation' && argv[1] === 'delete-stack')
    )
      return ['delete'];
    if (
      hasVerb(
        argv,
        /^(deploy|update-function-code|update-service|create-deployment|sync|cp|put-object|publish)$/,
      ) ||
      argv[0] === 'deploy'
    )
      return ['deploy'];
    const head = commandHead(argv);
    if (hasVerb(head, /^(get-|list-|describe-|ls$|head-)/) || argv.includes('--dry-run') || head[0] === 'sts')
      return ['read'];
    return ['write'];
  }
}

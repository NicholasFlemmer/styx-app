import { makeCredentialRef } from '../services/credential-vault';
import type { AdapterDeps, ConnectInput, GrantInfo, IssuedCredential, ProviderAdapter, Scope, TargetInfo, TestResult } from './types';
import { commandHead, expiryFor, hasVerb } from './types';

export interface StsLike {
  callerIdentity(creds: AwsKeys): Promise<{ arn: string; account: string }>;
  assumeRole(creds: AwsKeys, roleArn: string, policy: string, durationSeconds: number, sessionName: string): Promise<AwsSession>;
  federationToken(creds: AwsKeys, name: string, policy: string, durationSeconds: number): Promise<AwsSession>;
}
export interface AwsKeys { accessKeyId: string; secretAccessKey: string; region: string }
export interface AwsSession { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: number }

/** Session policy per scope. `read` → Get/List/Describe; `write` → everything except Delete/Terminate; `delete` lifts the deny. */
export function sessionPolicy(scope: Scope[]): string {
  const st: Record<string, unknown>[] = [];
  const s = new Set(scope);
  if (s.has('write') || s.has('deploy') || s.has('delete')) st.push({ Effect: 'Allow', Action: '*', Resource: '*' });
  else st.push({ Effect: 'Allow', Action: ['*:Get*', '*:List*', '*:Describe*', '*:Head*', 'sts:GetCallerIdentity'], Resource: '*' });
  if (!s.has('delete')) st.push({ Effect: 'Deny', Action: ['*:Delete*', '*:Terminate*', '*:Destroy*', '*:Remove*', 'iam:*'], Resource: '*' });
  return JSON.stringify({ Version: '2012-10-17', Statement: st });
}

/** Default STS implementation using @aws-sdk/client-sts (loaded lazily). */
export async function defaultSts(): Promise<StsLike> {
  const sdk = await import('@aws-sdk/client-sts');
  const client = (c: AwsKeys) => new sdk.STSClient({ region: c.region, credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey } });
  const toSession = (r: { Credentials?: { AccessKeyId?: string | undefined; SecretAccessKey?: string | undefined; SessionToken?: string | undefined; Expiration?: Date | undefined } | undefined }): AwsSession => {
    const c = r.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) throw new Error('STS returned no credentials');
    return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration?.getTime() ?? Date.now() + 3_600_000 };
  };
  return {
    callerIdentity: async (c) => {
      const r = await client(c).send(new sdk.GetCallerIdentityCommand({}));
      return { arn: r.Arn ?? '', account: r.Account ?? '' };
    },
    assumeRole: async (c, roleArn, policy, dur, name) => toSession(await client(c).send(new sdk.AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: name, Policy: policy, DurationSeconds: dur }))),
    federationToken: async (c, name, policy, dur) => toSession(await client(c).send(new sdk.GetFederationTokenCommand({ Name: name, Policy: policy, DurationSeconds: dur }))),
  };
}

/** AWS: long-lived keys in the vault; every grant gets short-lived STS credentials scoped by a session policy (scoped: true). */
export class AwsAdapter implements ProviderAdapter {
  readonly provider = 'aws' as const;
  readonly authMethod = 'key' as const;
  readonly tools = ['aws', 'sam', 'cdk'];
  constructor(private readonly deps: AdapterDeps, private readonly sts: () => Promise<StsLike> = defaultSts) {}

  async connect(input: ConnectInput, targetId: string) {
    if (input.method !== 'key') throw new Error('AWS connect expects an access key');
    const keys: AwsKeys = { accessKeyId: input.accessKeyId.trim(), secretAccessKey: input.secretAccessKey.trim(), region: input.region ?? 'us-east-1' };
    const id = await (await this.sts()).callerIdentity(keys);
    const ref = makeCredentialRef('aws', targetId, 'key');
    await this.deps.vault.set(ref, JSON.stringify(keys));
    return { credentialRef: ref, config: { region: keys.region, accountId: id.account, ...(input.roleArn ? { roleArn: input.roleArn } : {}) }, label: input.name ?? `AWS ${id.account}` };
  }

  private async keys(target: TargetInfo): Promise<AwsKeys> {
    if (!target.credentialRef) throw new Error('not connected');
    const raw = await this.deps.vault.get(target.credentialRef);
    if (!raw) throw new Error('credential missing from keychain');
    return JSON.parse(raw) as AwsKeys;
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
    const session = typeof roleArn === 'string' ? await sts.assumeRole(keys, roleArn, policy, seconds, `styx-${grant.id.slice(-12)}`) : await sts.federationToken(keys, `styx-${grant.id.slice(-12)}`, policy, seconds);
    const env: Record<string, string> = {
      AWS_ACCESS_KEY_ID: session.accessKeyId,
      AWS_SECRET_ACCESS_KEY: session.secretAccessKey,
      AWS_SESSION_TOKEN: session.sessionToken,
      AWS_REGION: keys.region,
      AWS_DEFAULT_REGION: keys.region,
    };
    return { kind: 'env', env, expiresAt: Math.min(expiresAt, session.expiration), scoped: true };
  }

  async revoke(): Promise<void> {
    /* STS credentials cannot be revoked early; they are short-lived and no longer delivered */
  }

  issuesScoped(): boolean {
    return true; // STS session policy narrows the long-lived key per grant
  }

  scopeOfCommand(argv: string[]): Scope[] {
    if (hasVerb(argv, /^(delete-|terminate-|remove-|destroy|rb$|rm$)/) || (argv[0] === 's3' && argv[1] === 'rm') || (argv[0] === 'cloudformation' && argv[1] === 'delete-stack')) return ['delete'];
    if (hasVerb(argv, /^(deploy|update-function-code|update-service|create-deployment|sync|cp|put-object|publish)$/) || argv[0] === 'deploy') return ['deploy'];
    const head = commandHead(argv);
    if (hasVerb(head, /^(get-|list-|describe-|ls$|head-)/) || argv.includes('--dry-run') || head[0] === 'sts') return ['read'];
    return ['write'];
  }
}

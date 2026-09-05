import { makeCredentialRef } from '../services/credential-vault';
import type { AdapterDeps, ConnectInput, GrantInfo, IssuedCredential, ProviderAdapter, Scope, TargetInfo, TestResult } from './types';
import { commandHead, expiryFor, hasVerb } from './types';

interface ServiceAccount { client_email: string; private_key: string; project_id?: string; token_uri?: string }

const READ_SCOPE = 'https://www.googleapis.com/auth/cloud-platform.read-only';
const FULL_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** GCP: service-account key in the vault; each grant exchanges a signed JWT for a ≤1h access token with read-only or full scope. */
export class GcpAdapter implements ProviderAdapter {
  readonly provider = 'gcp' as const;
  readonly authMethod = 'key' as const;
  readonly tools = ['gcloud', 'gsutil', 'bq'];
  constructor(private readonly deps: AdapterDeps) {}

  async connect(input: ConnectInput, targetId: string) {
    if (input.method !== 'service-account') throw new Error('GCP connect expects a service-account JSON key');
    const sa = JSON.parse(input.json) as ServiceAccount;
    if (!sa.client_email || !sa.private_key) throw new Error('Not a service-account key (client_email / private_key missing)');
    const projectId = input.projectId ?? sa.project_id;
    await this.accessToken(sa, FULL_SCOPE, 300);
    const ref = makeCredentialRef('gcp', targetId, 'key');
    await this.deps.vault.set(ref, JSON.stringify(sa));
    return { credentialRef: ref, config: { projectId, saEmail: sa.client_email }, label: `GCP ${projectId ?? sa.client_email}` };
  }

  private async sa(target: TargetInfo): Promise<ServiceAccount> {
    if (!target.credentialRef) throw new Error('not connected');
    const raw = await this.deps.vault.get(target.credentialRef);
    if (!raw) throw new Error('credential missing from keychain');
    return JSON.parse(raw) as ServiceAccount;
  }

  private async accessToken(sa: ServiceAccount, scope: string, seconds: number): Promise<{ token: string; expiresAt: number }> {
    const { SignJWT, importPKCS8 } = await import('jose');
    const key = await importPKCS8(sa.private_key, 'RS256');
    const now = Math.floor(this.deps.now() / 1000);
    const tokenUri = sa.token_uri ?? 'https://oauth2.googleapis.com/token';
    const jwt = await new SignJWT({ scope }).setProtectedHeader({ alg: 'RS256', typ: 'JWT' }).setIssuer(sa.client_email).setAudience(tokenUri).setIssuedAt(now).setExpirationTime(now + Math.min(seconds, 3600)).sign(key);
    const r = await this.deps.fetch(tokenUri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}` });
    if (!r.ok) throw new Error(`Google token exchange failed (${r.status})`);
    const j = (await r.json()) as { access_token: string; expires_in: number };
    return { token: j.access_token, expiresAt: this.deps.now() + j.expires_in * 1000 };
  }

  async test(target: TargetInfo): Promise<TestResult> {
    try {
      const sa = await this.sa(target);
      const t = await this.accessToken(sa, READ_SCOPE, 300);
      const pid = target.config['projectId'];
      if (typeof pid === 'string') {
        const r = await this.deps.fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${pid}`, { headers: { Authorization: `Bearer ${t.token}` } });
        if (!r.ok) return { ok: false, error: `project ${pid} not accessible (${r.status})` };
      }
      return { ok: true, identity: sa.client_email };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async issue(grant: GrantInfo, target: TargetInfo): Promise<IssuedCredential> {
    const sa = await this.sa(target);
    const now = this.deps.now();
    const expiresAt = expiryFor(grant, now) ?? now + 3_600_000;
    const readOnly = grant.scope.every((s) => s === 'read');
    const t = await this.accessToken(sa, readOnly ? READ_SCOPE : FULL_SCOPE, Math.floor((expiresAt - now) / 1000));
    const env: Record<string, string> = { CLOUDSDK_AUTH_ACCESS_TOKEN: t.token, GOOGLE_OAUTH_ACCESS_TOKEN: t.token };
    if (typeof target.config['projectId'] === 'string') {
      env['CLOUDSDK_CORE_PROJECT'] = target.config['projectId'];
      env['GOOGLE_CLOUD_PROJECT'] = target.config['projectId'];
    }
    return { kind: 'env', env, expiresAt: Math.min(expiresAt, t.expiresAt), scoped: readOnly };
  }

  async revoke(issued: IssuedCredential): Promise<void> {
    const token = issued.kind === 'env' ? issued.env['CLOUDSDK_AUTH_ACCESS_TOKEN'] : undefined;
    if (token) await this.deps.fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => undefined);
  }

  issuesScoped(scope: readonly Scope[]): boolean {
    return scope.every((s) => s === 'read'); // read → cloud-platform.read-only token; anything else gets the full scope
  }

  scopeOfCommand(argv: string[]): Scope[] {
    if (hasVerb(argv, /^(delete|rm|remove|destroy|undeploy)$/)) return ['delete'];
    if (hasVerb(argv, /^(deploy|rollout|submit|rsync|cp|mv)$/) || (argv[0] === 'run' && argv[1] === 'deploy') || (argv[0] === 'app' && argv[1] === 'deploy')) return ['deploy'];
    const head = commandHead(argv);
    if (hasVerb(head, /^(list|describe|get|ls|cat|stat|show|query|head)$/) || head[0] === 'auth' || head[0] === 'config') return ['read'];
    return ['write'];
  }
}

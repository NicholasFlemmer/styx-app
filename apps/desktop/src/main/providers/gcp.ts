import { makeCredentialRef } from '../services/credential-vault';
import {
  CliAuthError,
  cliFailure,
  cliInstall,
  firstLine,
  readCliEntry,
  semver,
  testToHealth,
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

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
  token_uri?: string;
}

const READ_SCOPE = 'https://www.googleapis.com/auth/cloud-platform.read-only';
const FULL_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const STS = 'https://sts.googleapis.com/v1/token';
/** gcloud caches tokens; a printed one may have anywhere up to an hour left. Used when tokeninfo is unreachable. */
const CLI_TOKEN_FALLBACK_MS = 30 * 60_000;

/**
 * GCP. Two modes behind one adapter:
 * - `cli` (primary): the account `gcloud auth login` already holds. Each grant runs `gcloud auth print-access-token
 *   --account <acct>` (never stored); `CLOUDSDK_CORE_PROJECT` from `config.projectId`. Read-only grants are
 *   down-scoped through the STS token exchange with a Credential Access Boundary when `config.buckets` lists the
 *   Cloud Storage buckets the project uses (CABs only cover Storage), else the token is handed over `scoped:false`.
 *   Revoke never calls Google: revoking a gcloud access token would sign the user out of gcloud.
 * - `key` (Advanced): service-account JSON in the vault; each grant exchanges a signed JWT for a ≤1h token with
 *   read-only or full scope.
 * Scope matrix: read → `cloud-platform.read-only` (key) / CAB objectViewer (cli, buckets) / full (cli, no buckets);
 * write/deploy/delete → `cloud-platform`.
 */
export class GcpAdapter implements ProviderAdapter {
  readonly provider = 'gcp' as const;
  readonly authMethod = 'key' as const;
  readonly tools = ['gcloud', 'gsutil', 'bq'];
  constructor(private readonly deps: AdapterDeps) {}

  async connect(input: ConnectInput, targetId: string) {
    if (input.method === 'cli') return this.connectCli(input, targetId);
    if (input.method !== 'service-account')
      throw new Error('GCP connect expects a service-account JSON key or a gcloud account');
    const sa = JSON.parse(input.json) as ServiceAccount;
    if (!sa.client_email || !sa.private_key)
      throw new Error('Not a service-account key (client_email / private_key missing)');
    const projectId = input.projectId ?? sa.project_id;
    await this.accessToken(sa, FULL_SCOPE, 300);
    const ref = makeCredentialRef('gcp', targetId, 'key');
    await this.deps.vault.set(ref, JSON.stringify(sa));
    return {
      credentialRef: ref,
      config: { projectId, saEmail: sa.client_email },
      label: `GCP ${projectId ?? sa.client_email}`,
    };
  }

  // --- cli mode --------------------------------------------------------------

  private async connectCli(input: Extract<ConnectInput, { method: 'cli' }>, targetId: string) {
    const account = input.account.trim();
    const cfg = input.config ?? {};
    const projectId =
      typeof cfg['projectId'] === 'string' && cfg['projectId']
        ? cfg['projectId']
        : await this.defaultProject();
    await this.cliToken(account, projectId); // proves the account is signed in; the token is dropped
    const ref = makeCredentialRef('gcp', targetId, 'cli');
    await this.deps.vault.set(
      ref,
      JSON.stringify({ kind: 'cli', account, ...(projectId ? { project: projectId } : {}) }),
    );
    const config: Record<string, unknown> = { ...cfg, account, ...(projectId ? { projectId } : {}) };
    return { credentialRef: ref, config, label: input.name ?? `GCP ${projectId ?? account}` };
  }

  private async defaultProject(): Promise<string | null> {
    const r = await this.deps.cli.run('gcloud', ['config', 'get-value', 'project', '--format=value(.)'], {
      timeoutMs: 10_000,
    });
    const v = firstLine(r.stdout);
    return r.exitCode === 0 && v && v !== '(unset)' ? v : null;
  }

  /** `gcloud auth print-access-token --account <acct>`; the token goes to the caller only. */
  private async cliToken(account: string, projectId: string | null): Promise<string> {
    const env: Record<string, string> = projectId ? { CLOUDSDK_CORE_PROJECT: projectId } : {};
    const r = await this.deps.cli.run('gcloud', ['auth', 'print-access-token', '--account', account], {
      env,
    });
    if (r.exitCode !== 0) throw cliFailure('gcloud', r);
    const token = firstLine(r.stdout);
    if (!token) throw new CliAuthError('gcloud printed no token', true);
    return token;
  }

  /** Remaining lifetime of a gcloud-issued token (tokeninfo is Google's own endpoint; the token never goes elsewhere). */
  private async tokenExpiry(token: string): Promise<number> {
    try {
      const r = await this.deps.fetch('https://oauth2.googleapis.com/tokeninfo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `access_token=${encodeURIComponent(token)}`,
      });
      if (!r.ok) return this.deps.now() + CLI_TOKEN_FALLBACK_MS;
      const j = (await r.json()) as { expires_in?: number | string };
      const s = Number(j.expires_in);
      return Number.isFinite(s) && s > 0
        ? this.deps.now() + s * 1000
        : this.deps.now() + CLI_TOKEN_FALLBACK_MS;
    } catch {
      return this.deps.now() + CLI_TOKEN_FALLBACK_MS;
    }
  }

  /** STS token exchange with a Credential Access Boundary: objectViewer on the listed buckets only. */
  private async downscope(
    token: string,
    buckets: string[],
  ): Promise<{ token: string; expiresAt: number } | null> {
    const boundary = {
      accessBoundary: {
        accessBoundaryRules: buckets.map((b) => ({
          availableResource: `//storage.googleapis.com/projects/_/buckets/${b}`,
          availablePermissions: ['inRole:roles/storage.objectViewer'],
        })),
      },
    };
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      subject_token: token,
      options: JSON.stringify(boundary),
    });
    const r = await this.deps.fetch(STS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) return null;
    return { token: j.access_token, expiresAt: this.deps.now() + (j.expires_in ?? 3600) * 1000 };
  }

  private static buckets(target: TargetInfo): string[] {
    const b = target.config['buckets'];
    return Array.isArray(b)
      ? b.filter((x): x is string => typeof x === 'string' && /^[a-z0-9._-]{3,222}$/.test(x))
      : [];
  }

  async cliStatus(): Promise<CliStatus> {
    const loginCommand = 'gcloud auth login';
    const { binary, version } = await cliInstall(this.deps.cli, 'gcloud', ['--version'], (out) =>
      semver(firstLine(out)),
    );
    if (!binary) return { installed: false, binary: null, version: null, loginCommand, accounts: [] };
    const list = await this.deps.cli.run('gcloud', ['auth', 'list', '--format=json'], { timeoutMs: 15_000 });
    let accounts: CliStatus['accounts'] = [];
    if (list.exitCode === 0) {
      try {
        const rows = JSON.parse(list.stdout || '[]') as { account?: string; status?: string }[];
        const project = await this.defaultProject();
        accounts = rows
          .filter(
            (r): r is { account: string; status?: string } =>
              typeof r.account === 'string' && r.account.length > 0,
          )
          .map((r) => ({
            id: r.account,
            label: r.account,
            active: r.status === 'ACTIVE',
            ...(r.status === 'ACTIVE' && project ? { detail: `project ${project}` } : {}),
          }));
      } catch {
        accounts = [];
      }
    }
    return { installed: true, binary, version, loginCommand, accounts };
  }

  cliLoginCommand(account?: string): CliCommand {
    return { bin: 'gcloud', args: ['auth', 'login', ...(account ? ['--', account] : [])] };
  }

  async health(target: TargetInfo): Promise<HealthResult> {
    const entry = await readCliEntry(this.deps.vault, target).catch((e: Error) => {
      throw new CliAuthError(e.message, false);
    });
    if (!entry) return testToHealth(await this.test(target));
    try {
      await this.cliToken(entry.account, entry.project ?? null);
      return { ok: true, identity: entry.account };
    } catch (e) {
      return {
        ok: false,
        expired: e instanceof CliAuthError ? e.expired : false,
        error: (e as Error).message,
      };
    }
  }

  // --- key mode --------------------------------------------------------------

  private async sa(target: TargetInfo): Promise<ServiceAccount> {
    if (!target.credentialRef) throw new Error('not connected');
    const raw = await this.deps.vault.get(target.credentialRef);
    if (!raw) throw new Error('credential missing from keychain');
    return JSON.parse(raw) as ServiceAccount;
  }

  private async accessToken(
    sa: ServiceAccount,
    scope: string,
    seconds: number,
  ): Promise<{ token: string; expiresAt: number }> {
    const { SignJWT, importPKCS8 } = await import('jose');
    const key = await importPKCS8(sa.private_key, 'RS256');
    const now = Math.floor(this.deps.now() / 1000);
    const tokenUri = sa.token_uri ?? 'https://oauth2.googleapis.com/token';
    const jwt = await new SignJWT({ scope })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(sa.client_email)
      .setAudience(tokenUri)
      .setIssuedAt(now)
      .setExpirationTime(now + Math.min(seconds, 3600))
      .sign(key);
    const r = await this.deps.fetch(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    });
    if (!r.ok) throw new Error(`Google token exchange failed (${r.status})`);
    const j = (await r.json()) as { access_token: string; expires_in: number };
    return { token: j.access_token, expiresAt: this.deps.now() + j.expires_in * 1000 };
  }

  private async projectReachable(token: string, pid: unknown): Promise<string | null> {
    if (typeof pid !== 'string') return null;
    const r = await this.deps.fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${pid}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return r.ok ? null : `project ${pid} not accessible (${r.status})`;
  }

  async test(target: TargetInfo): Promise<TestResult> {
    try {
      const entry = await readCliEntry(this.deps.vault, target);
      if (entry) {
        const token = await this.cliToken(entry.account, entry.project ?? null);
        const err = await this.projectReachable(token, target.config['projectId']);
        return err ? { ok: false, error: err } : { ok: true, identity: entry.account };
      }
      const sa = await this.sa(target);
      const t = await this.accessToken(sa, READ_SCOPE, 300);
      const err = await this.projectReachable(t.token, target.config['projectId']);
      return err ? { ok: false, error: err } : { ok: true, identity: sa.client_email };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async issue(grant: GrantInfo, target: TargetInfo): Promise<IssuedCredential> {
    const now = this.deps.now();
    const expiresAt = expiryFor(grant, now) ?? now + 3_600_000;
    const readOnly = grant.scope.every((s) => s === 'read');
    const env: Record<string, string> = {};
    if (typeof target.config['projectId'] === 'string') {
      env['CLOUDSDK_CORE_PROJECT'] = target.config['projectId'];
      env['GOOGLE_CLOUD_PROJECT'] = target.config['projectId'];
    }
    const entry = await readCliEntry(this.deps.vault, target);
    if (entry) {
      const project =
        entry.project ?? (typeof target.config['projectId'] === 'string' ? target.config['projectId'] : null);
      const raw = await this.cliToken(entry.account, project);
      const buckets = GcpAdapter.buckets(target);
      const scoped = readOnly && buckets.length > 0 ? await this.downscope(raw, buckets) : null;
      const token = scoped?.token ?? raw;
      const tokenExpiry = scoped?.expiresAt ?? (await this.tokenExpiry(raw));
      env['CLOUDSDK_AUTH_ACCESS_TOKEN'] = token;
      env['GOOGLE_OAUTH_ACCESS_TOKEN'] = token;
      return {
        kind: 'env',
        env,
        expiresAt: Math.min(expiresAt, tokenExpiry),
        scoped: scoped !== null,
        handle: 'cli',
      };
    }
    const sa = await this.sa(target);
    const t = await this.accessToken(
      sa,
      readOnly ? READ_SCOPE : FULL_SCOPE,
      Math.floor((expiresAt - now) / 1000),
    );
    env['CLOUDSDK_AUTH_ACCESS_TOKEN'] = t.token;
    env['GOOGLE_OAUTH_ACCESS_TOKEN'] = t.token;
    return { kind: 'env', env, expiresAt: Math.min(expiresAt, t.expiresAt), scoped: readOnly };
  }

  async revoke(issued: IssuedCredential): Promise<void> {
    // cli mode: the token is gcloud's own; revoking it upstream would sign the user out. Delivery simply stops.
    if (issued.kind !== 'env' || issued.handle === 'cli') return;
    const token = issued.env['CLOUDSDK_AUTH_ACCESS_TOKEN'];
    if (token)
      await this.deps
        .fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' })
        .catch(() => undefined);
  }

  issuesScoped(scope: readonly Scope[], target?: Pick<TargetInfo, 'credentialRef' | 'config'>): boolean {
    if (!scope.every((s) => s === 'read')) return false; // anything but read gets the full scope
    if (target && target.credentialRef?.endsWith(':cli'))
      return (
        GcpAdapter.buckets({
          id: '',
          provider: 'gcp',
          name: '',
          env: 'prod',
          config: target.config,
          credentialRef: target.credentialRef,
        }).length > 0
      );
    return true; // key mode: cloud-platform.read-only token
  }

  scopeOfCommand(argv: string[]): Scope[] {
    if (hasVerb(argv, /^(delete|rm|remove|destroy|undeploy)$/)) return ['delete'];
    if (
      hasVerb(argv, /^(deploy|rollout|submit|rsync|cp|mv)$/) ||
      (argv[0] === 'run' && argv[1] === 'deploy') ||
      (argv[0] === 'app' && argv[1] === 'deploy')
    )
      return ['deploy'];
    const head = commandHead(argv);
    if (
      hasVerb(head, /^(list|describe|get|ls|cat|stat|show|query|head)$/) ||
      head[0] === 'auth' ||
      head[0] === 'config'
    )
      return ['read'];
    return ['write'];
  }
}

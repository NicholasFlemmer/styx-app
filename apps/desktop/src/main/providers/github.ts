import { makeCredentialRef } from '../services/credential-vault';
import type { AdapterDeps, ConnectInput, GrantInfo, IssuedCredential, ProviderAdapter, Scope, TargetInfo, TestResult } from './types';
import { hasVerb } from './types';

const DEVICE_SCOPES = 'repo read:org workflow';

/**
 * GitHub. Connect via device flow (Styx GitHub App / OAuth app client id) or a pasted token.
 * Token issuance is not scoped per grant by GitHub (installation tokens need a server); scope is enforced at the `gh` shim.
 */
export class GitHubAdapter implements ProviderAdapter {
  readonly provider = 'github' as const;
  readonly authMethod = 'oauth' as const;
  readonly tools = ['gh', 'git-credential-styx'];

  constructor(private readonly deps: AdapterDeps, private readonly clientId: string | undefined = process.env['STYX_GITHUB_CLIENT_ID']) {}

  async connect(input: ConnectInput, targetId: string): Promise<{ credentialRef: string; config: Record<string, unknown>; label: string }> {
    let token: string;
    if (input.method === 'token') token = input.token.trim();
    else if (input.method === 'device') token = await this.deviceFlow(input);
    else throw new Error('GitHub supports token or device connect');
    const me = await this.whoami(token);
    const ref = makeCredentialRef('github', targetId, 'oauth');
    await this.deps.vault.set(ref, JSON.stringify({ token }));
    const cfg = input.method === 'token' ? (input.config ?? {}) : {};
    const owner = (cfg['owner'] as string | undefined) ?? me.login;
    const repo = cfg['repo'] as string | undefined;
    return { credentialRef: ref, config: { ...cfg, owner, login: me.login }, label: repo ? `GitHub ${owner}/${repo}` : `GitHub ${owner}` };
  }

  private async deviceFlow(input: Extract<ConnectInput, { method: 'device' }>): Promise<string> {
    if (!this.clientId) throw new Error('GitHub device flow needs STYX_GITHUB_CLIENT_ID; paste a token instead.');
    const start = await this.deps.fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: this.clientId, scope: DEVICE_SCOPES }),
    });
    const s = (await start.json()) as { device_code: string; user_code: string; verification_uri: string; interval?: number; expires_in?: number };
    input.onCode({ userCode: s.user_code, verificationUri: s.verification_uri });
    const deadline = this.deps.now() + (s.expires_in ?? 900) * 1000;
    let interval = (s.interval ?? 5) * 1000;
    while (this.deps.now() < deadline) {
      if (input.abort?.aborted) throw new Error('cancelled');
      await new Promise((r) => setTimeout(r, interval));
      const poll = await this.deps.fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: this.clientId, device_code: s.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
      });
      const p = (await poll.json()) as { access_token?: string; error?: string };
      if (p.access_token) return p.access_token;
      if (p.error === 'slow_down') interval += 5000;
      else if (p.error && p.error !== 'authorization_pending') throw new Error(`GitHub: ${p.error}`);
    }
    throw new Error('GitHub device flow timed out');
  }

  private async whoami(token: string): Promise<{ login: string }> {
    const r = await this.deps.fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'styx' } });
    if (!r.ok) throw new Error(`GitHub rejected the token (${r.status})`);
    return (await r.json()) as { login: string };
  }

  async test(target: TargetInfo): Promise<TestResult> {
    try {
      const token = await this.token(target);
      const me = await this.whoami(token);
      return { ok: true, identity: me.login };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  private async token(target: TargetInfo): Promise<string> {
    if (!target.credentialRef) throw new Error('not connected');
    const raw = await this.deps.vault.get(target.credentialRef);
    if (!raw) throw new Error('credential missing from keychain');
    return (JSON.parse(raw) as { token: string }).token;
  }

  async issue(grant: GrantInfo, target: TargetInfo): Promise<IssuedCredential> {
    const token = await this.token(target);
    return { kind: 'env', env: { GH_TOKEN: token, GITHUB_TOKEN: token }, expiresAt: grant.expiresAt, scoped: false };
  }

  async revoke(): Promise<void> {
    /* nothing to revoke server-side; delivery simply stops */
  }

  scopeOfCommand(argv: string[]): Scope[] {
    const [group, verb] = argv;
    if (argv[0] === 'auth') return ['read'];
    if (hasVerb(argv, /^(delete|--delete-branch|--delete)$/) || (group === 'repo' && verb === 'delete')) return ['delete'];
    if (['create', 'merge', 'edit', 'close', 'reopen', 'comment', 'review', 'push', 'sync', 'fork', 'rename', 'release', 'ready', 'checkout'].includes(verb ?? '')) return ['write'];
    if (group === 'workflow' && verb === 'run') return ['deploy'];
    return ['read'];
  }
}

import { makeCredentialRef } from '../services/credential-vault';
import type { AdapterDeps, ConnectInput, GrantInfo, IssuedCredential, ProviderAdapter, Scope, TargetInfo, TestResult } from './types';
import { hasVerb } from './types';

/** Vercel: token from the dashboard (or imported from `vercel login`). No per-grant scoping API; scope enforced at the shim. */
export class VercelAdapter implements ProviderAdapter {
  readonly provider = 'vercel' as const;
  readonly authMethod = 'oauth' as const;
  readonly tools = ['vercel'];
  constructor(private readonly deps: AdapterDeps) {}

  async connect(input: ConnectInput, targetId: string) {
    if (input.method !== 'token') throw new Error('Vercel connect expects a token');
    const me = await this.whoami(input.token.trim());
    const ref = makeCredentialRef('vercel', targetId, 'oauth');
    await this.deps.vault.set(ref, JSON.stringify({ token: input.token.trim() }));
    return { credentialRef: ref, config: { ...(input.config ?? {}), username: me }, label: input.name ?? 'Vercel' };
  }

  private async whoami(token: string): Promise<string> {
    const r = await this.deps.fetch('https://api.vercel.com/v2/user', { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Vercel rejected the token (${r.status})`);
    const j = (await r.json()) as { user?: { username?: string; email?: string } };
    return j.user?.username ?? j.user?.email ?? 'vercel user';
  }

  async test(target: TargetInfo): Promise<TestResult> {
    try {
      return { ok: true, identity: await this.whoami(await this.token(target)) };
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
    const env: Record<string, string> = { VERCEL_TOKEN: token };
    if (typeof target.config['teamId'] === 'string') env['VERCEL_ORG_ID'] = target.config['teamId'];
    if (typeof target.config['projectId'] === 'string') env['VERCEL_PROJECT_ID'] = target.config['projectId'];
    return { kind: 'env', env, expiresAt: grant.expiresAt, scoped: false };
  }

  async revoke(): Promise<void> {}

  scopeOfCommand(argv: string[]): Scope[] {
    const [cmd, sub] = argv;
    if (cmd === 'remove' || cmd === 'rm' || (cmd === 'env' && sub === 'rm') || (cmd === 'domains' && sub === 'rm') || (cmd === 'projects' && sub === 'rm')) return ['delete'];
    if (cmd === undefined || cmd === 'deploy' || cmd === 'promote' || cmd === 'rollback' || cmd === 'redeploy' || cmd === 'alias' || cmd === 'build') return ['deploy'];
    if (cmd === 'env' && (sub === 'add' || sub === 'pull')) return sub === 'pull' ? ['read'] : ['write'];
    if (hasVerb(argv, /^(add|link|set)$/)) return ['write'];
    return ['read'];
  }
}

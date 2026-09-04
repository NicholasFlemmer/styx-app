import { makeCredentialRef } from '../services/credential-vault';
import type { AdapterDeps, ConnectInput, GrantInfo, IssuedCredential, ProviderAdapter, Scope, TargetInfo, TestResult } from './types';

/** Supabase: personal access token (PKCE OAuth needs a registered Styx OAuth app; token paste ships in v1). */
export class SupabaseAdapter implements ProviderAdapter {
  readonly provider = 'supabase' as const;
  readonly authMethod = 'oauth' as const;
  readonly tools = ['supabase'];
  constructor(private readonly deps: AdapterDeps) {}

  async connect(input: ConnectInput, targetId: string) {
    if (input.method !== 'token') throw new Error('Supabase connect expects a token');
    const projects = await this.projects(input.token.trim());
    const ref = makeCredentialRef('supabase', targetId, 'oauth');
    await this.deps.vault.set(ref, JSON.stringify({ token: input.token.trim() }));
    const cfg = input.config ?? {};
    const projectRef = (cfg['ref'] as string | undefined) ?? projects[0]?.id;
    return { credentialRef: ref, config: { ...cfg, ...(projectRef ? { ref: projectRef } : {}) }, label: input.name ?? 'Supabase' };
  }

  private async projects(token: string): Promise<{ id: string; name: string }[]> {
    const r = await this.deps.fetch('https://api.supabase.com/v1/projects', { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Supabase rejected the token (${r.status})`);
    return (await r.json()) as { id: string; name: string }[];
  }

  async test(target: TargetInfo): Promise<TestResult> {
    try {
      const ps = await this.projects(await this.token(target));
      const mine = ps.find((p) => p.id === target.config['ref']);
      return { ok: true, identity: mine ? `${mine.name} (${mine.id})` : `${ps.length} projects` };
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
    const env: Record<string, string> = { SUPABASE_ACCESS_TOKEN: token };
    if (typeof target.config['ref'] === 'string') env['SUPABASE_PROJECT_REF'] = target.config['ref'];
    return { kind: 'env', env, expiresAt: grant.expiresAt, scoped: false };
  }

  async revoke(): Promise<void> {}

  scopeOfCommand(argv: string[]): Scope[] {
    const [cmd, sub, sub2] = argv;
    if ((cmd === 'db' && sub === 'reset') || (cmd === 'projects' && sub === 'delete') || (cmd === 'branches' && sub === 'delete') || sub === 'delete' || sub === 'rm') return ['delete'];
    if (cmd === 'functions' && sub === 'deploy') return ['deploy'];
    if ((cmd === 'db' && (sub === 'push' || sub === 'seed')) || (cmd === 'migration' && (sub === 'up' || sub === 'repair')) || (cmd === 'secrets' && sub === 'set') || sub === 'create' || sub === 'update' || sub2 === 'push') return ['write'];
    return ['read'];
  }
}

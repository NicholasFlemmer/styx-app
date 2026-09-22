import { AwsAdapter } from './aws';
import { GcpAdapter } from './gcp';
import { GitHubAdapter } from './github';
import { SshAdapter, type SshAdapterOptions } from './ssh';
import { SupabaseAdapter } from './supabase';
import type { AdapterDeps, Provider, ProviderAdapter } from './types';
import { VercelAdapter } from './vercel';

export * from './types';
export { sessionPolicy } from './aws';
export { StyxSshAgent } from './ssh-agent';

export class ProviderRegistry {
  private readonly adapters: Map<Provider, ProviderAdapter>;
  constructor(deps: AdapterDeps, ssh: SshAdapterOptions = {}) {
    const list: ProviderAdapter[] = [
      new GitHubAdapter(deps),
      new VercelAdapter(deps),
      new SupabaseAdapter(deps),
      new AwsAdapter(deps),
      new GcpAdapter(deps),
      new SshAdapter(deps, ssh),
    ];
    this.adapters = new Map(list.map((a) => [a.provider, a]));
  }
  get(provider: Provider): ProviderAdapter {
    const a = this.adapters.get(provider);
    if (!a) throw new Error(`no adapter for ${provider}`);
    return a;
  }
  /** Which provider a shim tool belongs to (`gh` → github, `aws` → aws …). */
  forTool(tool: string): ProviderAdapter | null {
    for (const a of this.adapters.values()) if (a.tools.includes(tool)) return a;
    return null;
  }
  all(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }
}

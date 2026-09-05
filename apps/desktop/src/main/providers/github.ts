import { makeCredentialRef } from '../services/credential-vault';
import type { AdapterDeps, ConnectInput, GrantInfo, IssuedCredential, ProviderAdapter, Scope, TargetInfo, TestResult } from './types';
import { hasVerb } from './types';

const DEVICE_SCOPES = 'repo read:org workflow';

export interface CreatedRepo {
  fullName: string;
  cloneUrl: string;
  htmlUrl: string;
  defaultBranch: string;
}

export interface TemplateRepo {
  name: string;
  fullName: string;
}

/** Repo-level GitHub operations ProjectService needs (repo creation, `styx-template` discovery). */
export interface GitHubRepoApi {
  /** The login the stored token belongs to (from `config.login`, else `/user`). */
  login(target: TargetInfo): Promise<string>;
  /** `POST /user/repos` for the token owner; `POST /orgs/{owner}/repos` when `owner` is someone else (an org). */
  createRepo(target: TargetInfo, opts: { name: string; owner: string | null; isPrivate: boolean }): Promise<CreatedRepo>;
  /** Repos tagged `styx-template` in `org` (spec §4.12 Template tile). */
  templateRepos(target: TargetInfo, org: string): Promise<TemplateRepo[]>;
  /** Raw token for a one-shot `git push` auth header; never persisted by the caller. */
  pushToken(target: TargetInfo): Promise<string>;
}

/**
 * GitHub. Connect via device flow (Styx GitHub App / OAuth app client id) or a pasted token.
 * Token issuance is not scoped per grant by GitHub (installation tokens need a server); scope is enforced at the `gh` shim.
 */
export class GitHubAdapter implements ProviderAdapter, GitHubRepoApi {
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

  private headers(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'styx', 'X-GitHub-Api-Version': '2022-11-28' };
  }

  async login(target: TargetInfo): Promise<string> {
    const cfg = target.config['login'];
    if (typeof cfg === 'string' && cfg) return cfg;
    return (await this.whoami(await this.token(target))).login;
  }

  async pushToken(target: TargetInfo): Promise<string> {
    return this.token(target);
  }

  async createRepo(target: TargetInfo, opts: { name: string; owner: string | null; isPrivate: boolean }): Promise<CreatedRepo> {
    const token = await this.token(target);
    const login = await this.login(target);
    const owner = opts.owner && opts.owner !== login ? opts.owner : null;
    const url = owner ? `https://api.github.com/orgs/${encodeURIComponent(owner)}/repos` : 'https://api.github.com/user/repos';
    const r = await this.deps.fetch(url, {
      method: 'POST',
      headers: { ...this.headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: opts.name, private: opts.isPrivate, auto_init: false }),
    });
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { message?: string; errors?: { message?: string }[] };
      const detail = body.errors?.map((e) => e.message).filter(Boolean).join('; ');
      throw new Error(`GitHub could not create the repo (${r.status}): ${body.message ?? r.statusText}${detail ? ` — ${detail}` : ''}`);
    }
    const repo = (await r.json()) as { full_name: string; clone_url: string; html_url: string; default_branch?: string };
    return { fullName: repo.full_name, cloneUrl: repo.clone_url, htmlUrl: repo.html_url, defaultBranch: repo.default_branch ?? 'main' };
  }

  async templateRepos(target: TargetInfo, org: string): Promise<TemplateRepo[]> {
    const token = await this.token(target);
    const q = encodeURIComponent(`topic:styx-template org:${org}`);
    const r = await this.deps.fetch(`https://api.github.com/search/repositories?q=${q}&per_page=50`, { headers: this.headers(token) });
    if (!r.ok) throw new Error(`GitHub template search failed (${r.status})`);
    const body = (await r.json()) as { items?: { name: string; full_name: string }[] };
    return (body.items ?? []).map((i) => ({ name: i.name, fullName: i.full_name }));
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

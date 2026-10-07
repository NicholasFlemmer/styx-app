import { makeCredentialRef } from '../services/credential-vault';
import {
  ACCOUNT_PATTERN,
  CliAuthError,
  cliFailure,
  cliInstall,
  firstLine,
  parseGhAuthStatus,
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
import { commandHead, hasVerb, isHelp, shortFlags } from './types';

/** Read-only `gh <group> <verb>` verbs; anything else defaults to write. */
const GH_READ_VERBS = new Set([
  'view',
  'list',
  'ls',
  'status',
  'diff',
  'checks',
  'download',
  'watch',
  'search',
  'browse',
  'clone',
  'get',
  'verify',
  'token',
]);

/**
 * `gh api [-X METHOD] …`: the method decides (GET when absent), but any body token makes gh POST. Body tokens:
 * `-f k=v` / `-F k=v`, their attached forms `-fk=v` / `-Fk=v`, clustered forms (`-if k=v`), `--field` /
 * `--raw-field` / `--input` (bare or `=`). `-X` is read attached, clustered (`-iX DELETE`) or separate.
 * Only GET/HEAD with no body is a read.
 */
function apiScope(rest: string[]): Scope[] {
  let method = 'GET';
  let hasBody = false;
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i] ?? '';
    if (a === '--method') method = (rest[i + 1] ?? '').toUpperCase();
    else if (a.startsWith('--method=')) method = a.slice('--method='.length).toUpperCase();
    else if (/^--(field|raw-field|input)(=|$)/.test(a)) hasBody = true;
    else if (a.startsWith('-') && !a.startsWith('--')) {
      const { flags, value, consumedNext } = shortFlags(a, rest[i + 1], 'XfFHq');
      if (flags.includes('f') || flags.includes('F')) hasBody = true;
      if (flags.at(-1) === 'X') method = (value ?? '').toUpperCase();
      if (consumedNext) i += 1;
    }
  }
  if (method === 'DELETE') return ['delete'];
  if ((method === 'GET' || method === 'HEAD') && !hasBody) return ['read'];
  return ['write'];
}

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
  createRepo(
    target: TargetInfo,
    opts: { name: string; owner: string | null; isPrivate: boolean },
  ): Promise<CreatedRepo>;
  /** Repos tagged `styx-template` in `org` (spec §4.12 Template tile). */
  templateRepos(target: TargetInfo, org: string): Promise<TemplateRepo[]>;
  /** Raw token for a one-shot `git push` auth header; never persisted by the caller. */
  pushToken(target: TargetInfo): Promise<string>;
}

const GH_HOST = 'github.com';
const GH_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

/**
 * GitHub. Connect with the `gh` CLI's login (primary: `gh auth token --hostname github.com [--user <login>]` on
 * every use, nothing stored), or via device flow (Styx GitHub App / OAuth app client id) / a pasted token (Advanced).
 * Token issuance is not scoped per grant by GitHub (installation tokens need a server); scope is enforced at the `gh` shim.
 */
export class GitHubAdapter implements ProviderAdapter, GitHubRepoApi {
  readonly provider = 'github' as const;
  readonly authMethod = 'oauth' as const;
  readonly tools = ['gh'];

  constructor(
    private readonly deps: AdapterDeps,
    private readonly clientId: string | undefined = process.env['STYX_GITHUB_CLIENT_ID'],
  ) {}

  async connect(
    input: ConnectInput,
    targetId: string,
  ): Promise<{ credentialRef: string; config: Record<string, unknown>; label: string }> {
    if (input.method === 'cli') return this.connectCli(input, targetId);
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
    return {
      credentialRef: ref,
      config: { ...cfg, owner, login: me.login },
      label: repo ? `GitHub ${owner}/${repo}` : `GitHub ${owner}`,
    };
  }

  // --- cli mode --------------------------------------------------------------

  /** `gh auth token` for the account; the token is returned to the caller and never persisted. */
  private async cliToken(login: string): Promise<string> {
    if (!GH_LOGIN.test(login) || !ACCOUNT_PATTERN.test(login))
      throw new CliAuthError('invalid GitHub login', false);
    const r = await this.deps.cli.run('gh', ['auth', 'token', '--hostname', GH_HOST, '--user', login]);
    if (r.exitCode === 0) {
      const token = firstLine(r.stdout);
      if (!token) throw new CliAuthError('gh printed no token', true);
      return token;
    }
    // `--user` arrived with multi-account gh (2.40). Older releases hold one account: take it, but only after
    // confirming it is the account this target was connected with.
    if (!r.missing && !r.timedOut && /unknown flag: --user/.test(r.stderr)) {
      const single = await this.deps.cli.run('gh', ['auth', 'token', '--hostname', GH_HOST]);
      if (single.exitCode !== 0) throw cliFailure('gh', single);
      const token = firstLine(single.stdout);
      if (!token) throw new CliAuthError('gh printed no token', true);
      const me = await this.whoami(token);
      if (me.login.toLowerCase() !== login.toLowerCase())
        throw new CliAuthError(`gh is logged in as ${me.login}, not ${login}`, true);
      return token;
    }
    throw cliFailure('gh', r);
  }

  private async connectCli(input: Extract<ConnectInput, { method: 'cli' }>, targetId: string) {
    const login = input.account.trim();
    const token = await this.cliToken(login);
    const me = await this.whoami(token);
    if (me.login.toLowerCase() !== login.toLowerCase())
      throw new Error(`gh holds a token for ${me.login}, not ${login}`);
    const ref = makeCredentialRef('github', targetId, 'cli');
    await this.deps.vault.set(ref, JSON.stringify({ kind: 'cli', account: me.login }));
    const cfg = input.config ?? {};
    const owner = (cfg['owner'] as string | undefined) ?? me.login;
    const repo = cfg['repo'] as string | undefined;
    return {
      credentialRef: ref,
      config: { ...cfg, owner, login: me.login, account: me.login },
      label: input.name ?? (repo ? `GitHub ${owner}/${repo}` : `GitHub ${owner}`),
    };
  }

  async cliStatus(): Promise<CliStatus> {
    const loginCommand = 'gh auth login --web';
    const { binary, version } = await cliInstall(this.deps.cli, 'gh', ['--version'], (out) =>
      semver(firstLine(out)),
    );
    if (!binary) return { installed: false, binary: null, version: null, loginCommand, accounts: [] };
    // Exit 1 when nobody is logged in; the text still lists what it found. Never logged: it carries a masked token.
    const r = await this.deps.cli.run('gh', ['auth', 'status', '--hostname', GH_HOST], { timeoutMs: 15_000 });
    const accounts = parseGhAuthStatus(`${r.stdout}\n${r.stderr}`)
      .filter((a) => a.host === GH_HOST)
      .map((a) => ({
        id: a.login,
        label: a.login,
        active: a.active,
        detail: a.ok ? (a.scopes ? `scopes ${a.scopes}` : GH_HOST) : 'token invalid',
      }));
    return { installed: true, binary, version, loginCommand, accounts };
  }

  cliLoginCommand(): CliCommand {
    return { bin: 'gh', args: ['auth', 'login', '--web', '--hostname', GH_HOST, '--git-protocol', 'https'] };
  }

  async health(target: TargetInfo): Promise<HealthResult> {
    const entry = await readCliEntry(this.deps.vault, target).catch((e: Error) => {
      throw new CliAuthError(e.message, false);
    });
    if (!entry) return testToHealth(await this.test(target));
    try {
      const me = await this.whoami(await this.cliToken(entry.account));
      return { ok: true, identity: me.login };
    } catch (e) {
      return {
        ok: false,
        expired:
          e instanceof CliAuthError ? e.expired : /rejected the token \(40[13]\)/.test((e as Error).message),
        error: (e as Error).message,
      };
    }
  }

  private async deviceFlow(input: Extract<ConnectInput, { method: 'device' }>): Promise<string> {
    if (!this.clientId)
      throw new Error('GitHub device flow needs STYX_GITHUB_CLIENT_ID; paste a token instead.');
    const start = await this.deps.fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: this.clientId, scope: DEVICE_SCOPES }),
    });
    const s = (await start.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      interval?: number;
      expires_in?: number;
    };
    input.onCode({ userCode: s.user_code, verificationUri: s.verification_uri });
    const deadline = this.deps.now() + (s.expires_in ?? 900) * 1000;
    let interval = (s.interval ?? 5) * 1000;
    while (this.deps.now() < deadline) {
      if (input.abort?.aborted) throw new Error('cancelled');
      await new Promise((r) => setTimeout(r, interval));
      const poll = await this.deps.fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: this.clientId,
          device_code: s.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });
      const p = (await poll.json()) as { access_token?: string; error?: string };
      if (p.access_token) return p.access_token;
      if (p.error === 'slow_down') interval += 5000;
      else if (p.error && p.error !== 'authorization_pending') throw new Error(`GitHub: ${p.error}`);
    }
    throw new Error('GitHub device flow timed out');
  }

  private async whoami(token: string): Promise<{ login: string }> {
    const r = await this.deps.fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'styx',
      },
    });
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
    const entry = await readCliEntry(this.deps.vault, target);
    if (entry) return this.cliToken(entry.account);
    if (!target.credentialRef) throw new Error('not connected');
    const raw = await this.deps.vault.get(target.credentialRef);
    if (!raw) throw new Error('credential missing from keychain');
    return (JSON.parse(raw) as { token: string }).token;
  }

  private headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'styx',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  async login(target: TargetInfo): Promise<string> {
    const cfg = target.config['login'];
    if (typeof cfg === 'string' && cfg) return cfg;
    return (await this.whoami(await this.token(target))).login;
  }

  async pushToken(target: TargetInfo): Promise<string> {
    return this.token(target);
  }

  async createRepo(
    target: TargetInfo,
    opts: { name: string; owner: string | null; isPrivate: boolean },
  ): Promise<CreatedRepo> {
    const token = await this.token(target);
    const login = await this.login(target);
    const owner = opts.owner && opts.owner !== login ? opts.owner : null;
    const url = owner
      ? `https://api.github.com/orgs/${encodeURIComponent(owner)}/repos`
      : 'https://api.github.com/user/repos';
    const r = await this.deps.fetch(url, {
      method: 'POST',
      headers: { ...this.headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: opts.name, private: opts.isPrivate, auto_init: false }),
    });
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as {
        message?: string;
        errors?: { message?: string }[];
      };
      const detail = body.errors
        ?.map((e) => e.message)
        .filter(Boolean)
        .join('; ');
      throw new Error(
        `GitHub could not create the repo (${r.status}): ${body.message ?? r.statusText}${detail ? ` — ${detail}` : ''}`,
      );
    }
    const repo = (await r.json()) as {
      full_name: string;
      clone_url: string;
      html_url: string;
      default_branch?: string;
    };
    return {
      fullName: repo.full_name,
      cloneUrl: repo.clone_url,
      htmlUrl: repo.html_url,
      defaultBranch: repo.default_branch ?? 'main',
    };
  }

  async templateRepos(target: TargetInfo, org: string): Promise<TemplateRepo[]> {
    const token = await this.token(target);
    const q = encodeURIComponent(`topic:styx-template org:${org}`);
    const r = await this.deps.fetch(`https://api.github.com/search/repositories?q=${q}&per_page=50`, {
      headers: this.headers(token),
    });
    if (!r.ok) throw new Error(`GitHub template search failed (${r.status})`);
    const body = (await r.json()) as { items?: { name: string; full_name: string }[] };
    return (body.items ?? []).map((i) => ({ name: i.name, fullName: i.full_name }));
  }

  async issue(grant: GrantInfo, target: TargetInfo): Promise<IssuedCredential> {
    const token = await this.token(target);
    return {
      kind: 'env',
      env: { GH_TOKEN: token, GITHUB_TOKEN: token },
      expiresAt: grant.expiresAt,
      scoped: false,
    };
  }

  async revoke(): Promise<void> {
    /* nothing to revoke server-side; delivery simply stops */
  }

  scopeOfCommand(argv: string[]): Scope[] {
    const [group, verb] = commandHead(argv);
    if (isHelp(argv) || group === 'auth') return ['read'];
    if (group === 'api') return apiScope(argv.slice(1));
    if (
      hasVerb(argv, /^(delete|--delete-branch|--delete)$/) ||
      (group === 'repo' && verb === 'delete') ||
      (group === 'release' && verb === 'delete')
    )
      return ['delete'];
    if (group === 'workflow' && verb === 'run') return ['deploy'];
    if (verb !== undefined && GH_READ_VERBS.has(verb)) return ['read'];
    // Everything else — `secret set`, `variable set`, `run cancel|rerun`, `pr merge`, and verbs added by newer `gh`
    // releases — is a write until proven otherwise (fail closed).
    return ['write'];
  }
}

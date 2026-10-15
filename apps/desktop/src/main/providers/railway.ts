/**
 * Railway (issue #24).
 *
 * Sources (checked 2026-10-15):
 * - https://docs.railway.com/reference/cli-api (commands; RAILWAY_TOKEN = project token, RAILWAY_API_TOKEN = account
 *   or workspace token)
 * - https://railway.com/auth.md and https://docs.railway.com/guides/public-api (account / workspace / project tokens,
 *   `Authorization: Bearer` vs `Project-Access-Token`, endpoint https://backboard.railway.com/graphql/v2)
 * - https://docs.railway.com/integrations/api/api-cookbook (`me`, `projects`, `environments`, `projectToken`)
 * - The public schema (introspection of backboard.railway.com/graphql/v2): `projectTokenCreate(input:
 *   { projectId, environmentId, name }): String` returns the token, `projectTokens(projectId)` lists `{ id name
 *   createdAt }`, `projectTokenDelete(id)`. There is no expiry field: project tokens live until deleted.
 * - https://github.com/railwayapp/cli/blob/master/src/config.rs (`~/.railway/config.json`: `user.accessToken` for the
 *   OAuth login, legacy `user.token`; `tokenExpiresAt`)
 *
 * Auth modes. Primary: the login `railway login` holds, read from the CLI's config file on every use, never copied.
 * Advanced: an account or workspace token pasted into the vault.
 *
 * A target is one environment of one project (`config.environmentId`, the project picker lists `project ·
 * environment`), which is exactly what a Railway project token reaches. Issue: every grant mints a project token for
 * that environment (`styx-<grantId>-<ms>`), handed over as RAILWAY_TOKEN, and deletes it on revoke. Railway tokens
 * cannot expire on their own, so Styx caps each at an hour (re-minted while the grant lives, the old one deleted)
 * and sweeps `styx-` tokens older than two hours that a restart left behind. The token is narrowed to one
 * environment but not by scope (a project token can deploy, change variables and run `railway down`), so it is
 * reported unscoped and prod always asks with OS authentication. A staging target may point at the production
 * environment (owner decision, row 164: warned and audited, not refused). Minting failure never falls back to the
 * stored login.
 */
import { builtInDeployCommand, PROVIDER_PROJECT_REF } from '@styx/core';
import { z } from 'zod';
import { makeCredentialRef } from '../services/credential-vault';
import { logger } from '../services/logger';
import {
  CliAuthError,
  parseStoredToken,
  cliInstall,
  firstLine,
  readCliEntry,
  railwayConfigPath,
  semver,
  testToHealth,
} from './cli-auth';
import { pickProjectOf } from './project-pick';
import type {
  AdapterDeps,
  CliCommand,
  CliStatus,
  ConnectInput,
  GrantInfo,
  HealthResult,
  IssuedCredential,
  ProjectSource,
  ProviderAdapter,
  ProviderProject,
  Scope,
  TargetInfo,
  TestResult,
} from './types';
import { classifyArgv, expiryFor, HOUR, strictHelp } from './types';

const API = 'https://backboard.railway.com/graphql/v2';
/** Railway ids are UUIDs; core's project-id pattern admits them and nothing that reads as a flag. */
const RAILWAY_ID = PROVIDER_PROJECT_REF;
const MINT_PREFIX = 'styx-';
/** A minted token older than this is from a grant Styx no longer holds (every bundle lives ≤1h). */
const STALE_MS = 2 * HOUR;

const PROJECTS = `query { projects(first: 100) { edges { node { id name environments { edges { node { id name } } } } } } }`;
const ENVIRONMENT = `query ($id: String!) { environment(id: $id) { id name projectId } }`;
const ME = `query { me { email name } }`;
const MINT = `mutation ($input: ProjectTokenCreateInput!) { projectTokenCreate(input: $input) }`;
const TOKENS = `query ($projectId: String!, $after: String) { projectTokens(projectId: $projectId, first: 100, after: $after) { edges { node { id name createdAt } } pageInfo { hasNextPage endCursor } } }`;
/** Styx's own mint names: `styx-<grant ULID>-<epoch ms>`. Nothing else (a user's `styx-ci` token) is ever swept. */
const MINT_NAME = /^styx-[0-9A-HJKMNP-TV-Z]{26}-\d{13}$/;
/** Pages of 100 read before giving up (10 000 tokens). */
const MAX_PAGES = 100;
const DELETE = `mutation ($id: String!) { projectTokenDelete(id: $id) }`;

const projectsSchema = z.object({
  projects: z.object({
    edges: z.array(
      z.object({
        node: z.object({
          id: z.string(),
          name: z.string(),
          environments: z.object({
            edges: z.array(z.object({ node: z.object({ id: z.string(), name: z.string() }) })),
          }),
        }),
      }),
    ),
  }),
});
const environmentSchema = z.object({
  environment: z.object({ id: z.string(), name: z.string(), projectId: z.string() }),
});
const tokensSchema = z.object({
  projectTokens: z.object({
    edges: z.array(z.object({ node: z.object({ id: z.string(), name: z.string(), createdAt: z.string() }) })),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() }).nullish(),
  }),
});
const cliConfigSchema = z.object({
  user: z
    .object({
      token: z.string().nullish(),
      accessToken: z.string().nullish(),
      tokenExpiresAt: z.number().nullish(),
    })
    .nullish(),
});

/** `production`, `prod`, `prod-eu`, `live`: anything that reads as production (`preprod`, `product` don't). */
const isProductionName = (name: string): boolean =>
  /(^|[^a-z0-9])(prod|production|live)([^a-z0-9]|$)/i.test(name.trim());

/** `railway … -e staging` / `--environment=production`: the environment a command names, if it names one. */
function environmentFlag(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? '';
    if (a === '-e' || a === '--environment') return argv[i + 1] ?? null;
    if (a.startsWith('--environment=')) return a.slice('--environment='.length);
    if (/^-e[^-]/.test(a)) return a.slice(2).replace(/^=/, '');
  }
  return null;
}

/** Removal verbs as a subcommand (`environment delete`, `volume delete`, `variable delete`, `sandbox destroy`). */
const RW_DELETE_SUB = new Set(['delete', 'rm', 'remove', 'destroy']);
/** Subcommands that change something even when a read word follows (`environment new status` names an env). */
const RW_WRITE_SUB = new Set([
  'new',
  'create',
  'add',
  'set',
  'enable',
  'push',
  'apply',
  'run',
  'exec',
  'reset',
  'purge',
  'link',
  'update',
  'import',
  'credentials',
  'edit',
  'rename',
  'download',
  'upload',
  'ssh',
]);
/** Read-only words in the second or third command position (`deployment list`, `postgres pitr status`, `api schema`). */
const RW_READ_SUB = new Set([
  'list',
  'ls',
  'status',
  'info',
  'search',
  'describe',
  'schema',
  'history',
  'get',
  'plan',
  'pull',
  'show',
]);
/** Commands that only read (`railway status`, `railway logs`, `railway whoami`). */
const RW_READ_CMD = new Set([
  'whoami',
  'status',
  'list',
  'logs',
  'open',
  'docs',
  'metrics',
  'usage',
  'completion',
  'version',
]);
/**
 * Commands that run things with the environment's variables or reach into its services: `run`/`shell`/`dev` inject
 * the environment's secrets into a local process, `ssh`/`connect` open shells, `agent` and `api` can change anything.
 * Checked before the read list so `railway run ls` is never a read.
 */
const RW_WRITE_CMD = new Set([
  'run',
  'shell',
  'ssh',
  'connect',
  'dev',
  'agent',
  'login',
  'logout',
  'link',
  'unlink',
  'init',
]);

/** Commands that hand their remaining arguments to another program or shell: no flag after them is Railway's. */
const RW_PASSTHROUGH = new Set(['run', 'shell', 'ssh', 'connect', 'dev', 'agent', 'sandbox', 'api']);

export class RailwayAdapter implements ProviderAdapter {
  readonly provider = 'railway' as const;
  readonly authMethod = 'oauth' as const;
  readonly tools = ['railway'];
  readonly projectKey = 'environmentId';
  /**
   * Minted project tokens still alive, by handle, with what deleting them needs: the login that minted them is kept
   * here in memory (never persisted), so a revoke still works after the target's keychain entry is gone (target
   * removed, reconnected another way). Lost on restart: see `sweep`.
   */
  private readonly minted = new Map<
    string,
    { parent: string; projectId: string; name: string; expiresAt: number }
  >();
  constructor(private readonly deps: AdapterDeps) {}

  // --- api ---------------------------------------------------------------------

  private async gql<T>(
    token: string,
    query: string,
    variables: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    let r: Response;
    try {
      r = await this.deps.fetch(API, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
    } catch {
      // A fixed message: whatever the network layer said never reaches the UI, audit or logs.
      throw new Error('Could not reach Railway');
    }
    if (r.status === 401 || r.status === 403) throw new Error(`Railway rejected the token (${r.status})`);
    if (!r.ok) throw new Error(`Railway answered ${r.status}`);
    const body = (await r.json().catch(() => null)) as {
      data?: unknown;
      errors?: { message?: unknown }[];
    } | null;
    const first = body?.errors?.[0]?.message;
    // Only Railway's own auth diagnosis is recognised; other error text is never echoed.
    if (typeof first === 'string' && /not authori[sz]ed|unauthori[sz]ed/i.test(first))
      throw new Error('Railway rejected the token (401)');
    if (body?.errors !== undefined && body.errors.length > 0) throw new Error('Railway refused the request');
    const parsed = schema.safeParse(body?.data);
    if (!parsed.success) throw new Error('Railway returned something Styx could not read');
    return parsed.data;
  }

  private async environments(token: string): Promise<ProviderProject[]> {
    const data = await this.gql(token, PROJECTS, {}, projectsSchema);
    return data.projects.edges.flatMap(({ node: p }) =>
      p.environments.edges
        .filter(({ node: e }) => RAILWAY_ID.test(e.id))
        .map(({ node: e }) => ({ id: e.id, name: `${p.name} · ${e.name}`, region: null })),
    );
  }

  private async identity(token: string): Promise<string> {
    // `me` resolves for account tokens only; a workspace token is still a working login.
    const me = await this.gql(
      token,
      ME,
      {},
      z.object({ me: z.object({ email: z.string().nullish(), name: z.string().nullish() }) }),
    ).catch((e: Error) => {
      if (/rejected the token/.test(e.message)) throw e;
      return null;
    });
    return me?.me.email ?? me?.me.name ?? 'Railway token';
  }

  // --- cli mode ----------------------------------------------------------------

  private async readCliToken(): Promise<{ token: string; expiresAt: number | null } | null> {
    const raw = await this.deps.cli.readFile(railwayConfigPath(this.deps.cli));
    if (raw === null) return null;
    let parsed: z.infer<typeof cliConfigSchema>;
    try {
      parsed = cliConfigSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
    const user = parsed.user;
    const token = user?.accessToken || user?.token || '';
    if (!token) return null;
    const exp = user?.accessToken ? (user.tokenExpiresAt ?? null) : null;
    // `tokenExpiresAt` is a unix timestamp; accept seconds or milliseconds.
    return { token, expiresAt: exp === null ? null : exp < 1e12 ? exp * 1000 : exp };
  }

  /** The CLI's token, read on every use. An expired OAuth login gets one chance to refresh through the CLI itself. */
  private async cliToken(): Promise<{ token: string; expiresAt: number | null }> {
    const now = this.deps.now();
    let t = await this.readCliToken();
    if (t !== null && t.expiresAt !== null && t.expiresAt <= now + 60_000) {
      await this.deps.cli.run('railway', ['whoami'], { timeoutMs: 15_000 }).catch(() => null);
      t = await this.readCliToken();
      if (t !== null && t.expiresAt !== null && t.expiresAt <= now + 60_000)
        throw new CliAuthError('railway CLI login has expired (run `railway login`)', true);
    }
    if (t === null) throw new CliAuthError('railway CLI is not logged in (run `railway login`)', true);
    return t;
  }

  private async token(target: TargetInfo): Promise<string> {
    if (await readCliEntry(this.deps.vault, target)) return (await this.cliToken()).token;
    if (!target.credentialRef) throw new Error('not connected');
    const raw = await this.deps.vault.get(target.credentialRef);
    if (!raw) throw new Error('credential missing from keychain');
    return parseStoredToken(raw);
  }

  // --- connect -----------------------------------------------------------------

  async connect(input: ConnectInput, targetId: string) {
    if (input.method === 'cli') return this.connectCli(input, targetId);
    if (input.method !== 'token') throw new Error('Railway connect expects a token or the railway CLI login');
    const token = input.token.trim();
    const cfg = input.config ?? {};
    const picked = pickProjectOf('railway', await this.environments(token), cfg['environmentId']);
    if (!picked.ok) throw new Error(picked.error);
    const who = await this.identity(token);
    const ref = makeCredentialRef('railway', targetId, 'oauth');
    await this.deps.vault.set(ref, JSON.stringify({ token }));
    return {
      credentialRef: ref,
      config: { ...cfg, environmentId: picked.project.id, account: who },
      label: input.name ?? 'Railway',
    };
  }

  private async connectCli(input: Extract<ConnectInput, { method: 'cli' }>, targetId: string) {
    const { token } = await this.cliToken();
    const cfg = input.config ?? {};
    const picked = pickProjectOf('railway', await this.environments(token), cfg['environmentId']);
    if (!picked.ok) throw new Error(picked.error);
    const ref = makeCredentialRef('railway', targetId, 'cli');
    const account = input.account.trim() || 'cli';
    await this.deps.vault.set(ref, JSON.stringify({ kind: 'cli', account }));
    return {
      credentialRef: ref,
      config: { ...cfg, environmentId: picked.project.id, account },
      label: input.name ?? 'Railway',
    };
  }

  async cliStatus(): Promise<CliStatus> {
    const loginCommand = 'railway login';
    const { binary, version } = await cliInstall(this.deps.cli, 'railway', ['--version'], (out) =>
      semver(out),
    );
    if (!binary) return { installed: false, binary: null, version: null, loginCommand, accounts: [] };
    const stored = await this.readCliToken();
    if (stored === null) return { installed: true, binary, version, loginCommand, accounts: [] };
    const who = await this.deps.cli.run('railway', ['whoami'], { timeoutMs: 15_000 });
    // "Logged in as Nic (nic@acme.dev)": the address in brackets, else the whole line.
    const line = who.exitCode === 0 ? firstLine(who.stdout.trim()) : '';
    const label = /\(([^()\s]+@[^()\s]+)\)/.exec(line)?.[1] ?? line.replace(/^Logged in as\s+/i, '');
    return {
      installed: true,
      binary,
      version,
      loginCommand,
      accounts: [
        {
          id: 'cli',
          label: label || 'railway CLI login',
          active: who.exitCode === 0,
          ...(who.exitCode === 0 ? {} : { detail: 'login present, whoami failed' }),
        },
      ],
    };
  }

  cliLoginCommand(): CliCommand {
    return { bin: 'railway', args: ['login'] };
  }

  /** `railway up --ci`: the grant's project token already names the project and environment. */
  deployCommand(target: TargetInfo): CliCommand {
    return builtInDeployCommand(target) ?? { bin: 'railway', args: ['up', '--ci'] };
  }

  async listProjects(source: ProjectSource): Promise<ProviderProject[]> {
    const token =
      source.kind === 'token'
        ? source.token.trim()
        : source.kind === 'cli'
          ? (await this.cliToken()).token
          : await this.token(source.target);
    return this.environments(token);
  }

  async test(target: TargetInfo): Promise<TestResult> {
    try {
      const token = await this.token(target);
      const picked = pickProjectOf('railway', await this.environments(token), target.config['environmentId']);
      if (!picked.ok) return { ok: false, error: picked.error, needsProject: true };
      return { ok: true, identity: picked.project.name };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async health(target: TargetInfo): Promise<HealthResult> {
    // CLI mode: whether the login is there (and fresh) decides expiry, before any API call can blur it.
    const entry = await readCliEntry(this.deps.vault, target).catch(() => null);
    if (entry) {
      try {
        await this.cliToken();
      } catch (e) {
        return { ok: false, expired: e instanceof CliAuthError && e.expired, error: (e as Error).message };
      }
    }
    const t = await this.test(target);
    if (!t.ok && t.needsProject === true) return { ok: false, expired: false, error: t.error };
    // A healthy target is also when tokens left behind by a crash get cleaned up, not only on the next grant.
    if (t.ok) await this.sweepTarget(target).catch(() => undefined);
    return testToHealth(t);
  }

  private async sweepTarget(target: TargetInfo): Promise<void> {
    const id = target.config['environmentId'];
    if (typeof id !== 'string' || !RAILWAY_ID.test(id)) return;
    const token = await this.token(target);
    const { environment } = await this.gql(token, ENVIRONMENT, { id }, environmentSchema);
    if (RAILWAY_ID.test(environment.projectId))
      await this.sweep(token, environment.projectId, this.deps.now());
  }

  // --- issue / revoke ----------------------------------------------------------

  async issue(grant: GrantInfo, target: TargetInfo): Promise<IssuedCredential> {
    const now = this.deps.now();
    // Never longer than an hour, whatever the grant: Railway tokens don't expire, so Styx re-mints and deletes.
    const expiresAt = Math.min(expiryFor(grant, now) ?? now + HOUR, now + HOUR);
    const token = await this.token(target);
    const chosen = target.config['environmentId'];
    let environmentId: string;
    if (typeof chosen === 'string' && RAILWAY_ID.test(chosen)) environmentId = chosen;
    else {
      const picked = pickProjectOf('railway', await this.environments(token), chosen);
      if (!picked.ok) throw new Error(picked.error);
      environmentId = picked.project.id;
    }
    const { environment } = await this.gql(token, ENVIRONMENT, { id: environmentId }, environmentSchema);
    if (!RAILWAY_ID.test(environment.projectId))
      throw new Error('Railway returned something Styx could not read');
    // Owner decision (row 164): a staging target on the production environment is allowed; the connect modal and
    // the grant sheet warn, and the granted audit row records it (GrantService).
    await this.sweep(token, environment.projectId, now);
    const name = `${MINT_PREFIX}${grant.id}-${now}`;
    const minted = await this.gql(
      token,
      MINT,
      { input: { projectId: environment.projectId, environmentId: environment.id, name } },
      z.object({ projectTokenCreate: z.string().min(1) }),
    );
    const handle = `railway:${name}`;
    this.minted.set(handle, { parent: token, projectId: environment.projectId, name, expiresAt });
    return {
      kind: 'env',
      env: { RAILWAY_TOKEN: minted.projectTokenCreate },
      expiresAt,
      scoped: false,
      handle,
    };
  }

  /** Deletes the grant's project token upstream (Railway tokens have no expiry of their own). */
  async revoke(issued: IssuedCredential): Promise<void> {
    if (issued.kind !== 'env' || issued.handle === undefined) return;
    const m = this.minted.get(issued.handle);
    if (!m) return;
    this.minted.delete(issued.handle);
    try {
      const row = (await this.projectTokens(m.parent, m.projectId)).find((t) => t.name === m.name);
      if (row) await this.deleteToken(m.parent, row.id);
    } catch (e) {
      // The message is one of `gql`'s fixed strings; the next sweep deletes the token once it is stale.
      logger.warn('railway: deleting a minted project token failed', { error: (e as Error).message });
    }
  }

  private async projectTokens(
    token: string,
    projectId: string,
  ): Promise<{ id: string; name: string; createdAt: string }[]> {
    const out: { id: string; name: string; createdAt: string }[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const data: z.infer<typeof tokensSchema> = await this.gql(
        token,
        TOKENS,
        { projectId, after },
        tokensSchema,
      );
      out.push(...data.projectTokens.edges.map((e) => e.node));
      const next: { hasNextPage: boolean; endCursor?: string | null | undefined } | null | undefined =
        data.projectTokens.pageInfo;
      if (!next?.hasNextPage || !next.endCursor) break;
      after = next.endCursor;
    }
    return out;
  }

  private async deleteToken(token: string, id: string): Promise<void> {
    await this.gql(token, DELETE, { id }, z.object({ projectTokenDelete: z.boolean() }));
  }

  /** Deletes Styx-minted project tokens older than two hours that no live bundle holds (left by a crash or restart). */
  private async sweep(token: string, projectId: string, now: number): Promise<void> {
    // A bundle past its hour that nobody used again (an idle session or always grant) is deleted here, so no
    // Railway token outlives its hour by more than a health-check interval.
    for (const [handle, m] of this.minted)
      if (m.projectId === projectId && m.expiresAt <= now)
        await this.revoke({ kind: 'env', env: {}, expiresAt: m.expiresAt, scoped: false, handle });
    try {
      const live = new Set([...this.minted.values()].map((m) => m.name));
      for (const node of await this.projectTokens(token, projectId)) {
        const created = Date.parse(node.createdAt);
        if (!MINT_NAME.test(node.name) || live.has(node.name) || !(now - created > STALE_MS)) continue;
        await this.deleteToken(token, node.id);
      }
    } catch (e) {
      logger.warn('railway: sweeping stale project tokens failed', { error: (e as Error).message });
    }
  }

  // --- classification ----------------------------------------------------------

  /**
   * `-e production` → prod, `-e <other>` → non-prod, nothing → unknown (judged against prod). The token a target
   * mints is bound to that target's own environment, so `-e` only chooses which target's rules apply; a staging
   * target that shares production's environment (allowed with a warning, row 164) reaches production either way.
   */
  envOfCommand(argv: string[]): 'prod' | 'non-prod' | null {
    const env = environmentFlag(argv);
    if (env === null || env === '') return null;
    return isProductionName(env) ? 'prod' : 'non-prod';
  }

  scopeOfCommand(argv: string[]): Scope[] {
    return classifyArgv(argv, (head) => this.classify(head, argv));
  }

  private classify([cmd, sub, sub2]: string[], argv: string[]): Scope {
    // `railway run sh --help`: the `--help` belongs to `sh`, and `run` still injects the environment's variables.
    if (!(cmd !== undefined && RW_PASSTHROUGH.has(cmd)) && strictHelp(argv)) return 'read';
    if (cmd === undefined) return 'write';
    if (
      cmd === 'delete' ||
      cmd === 'down' ||
      (sub !== undefined && RW_DELETE_SUB.has(sub)) ||
      (sub2 !== undefined && RW_DELETE_SUB.has(sub2))
    )
      return 'delete';
    if (
      cmd === 'up' ||
      cmd === 'redeploy' ||
      cmd === 'deploy' ||
      cmd === 'restart' ||
      (cmd === 'functions' && sub === 'push') ||
      (cmd === 'config' && sub === 'apply')
    )
      return 'deploy';
    if (cmd === 'variables' || cmd === 'variable' || cmd === 'vars') {
      // v4: `railway variables --set K=V`; v5: `railway variable set K=V`. Listing shows values: a read.
      // Words anywhere count: a flag in between (`variable --json set K=V`) must not hide the verb.
      if (argv.some((a) => RW_DELETE_SUB.has(a))) return 'delete';
      if (
        argv.some((a) => a === '--set' || a.startsWith('--set=') || a === '--set-from-stdin' || a === 'set')
      )
        return 'write';
      return sub === undefined || sub === 'list' || sub === 'ls' ? 'read' : 'write';
    }
    // `railway api` runs any GraphQL operation; only its schema browsing reads.
    if (cmd === 'api') return sub === 'schema' || sub === 'search' || sub === 'describe' ? 'read' : 'write';
    if (RW_WRITE_CMD.has(cmd)) return 'write';
    if ((sub !== undefined && RW_WRITE_SUB.has(sub)) || (sub2 !== undefined && RW_WRITE_SUB.has(sub2)))
      return 'write';
    if (
      RW_READ_CMD.has(cmd) ||
      (sub !== undefined && RW_READ_SUB.has(sub)) ||
      (sub2 !== undefined && RW_READ_SUB.has(sub2))
    )
      return 'read';
    return 'write'; // unknown verbs fail closed
  }
}

/**
 * Fly.io (issue #23).
 *
 * Sources (checked 2026-10-15):
 * - https://docs.fly.io/security/tokens (token kinds: deploy / org / readonly / ssh / machine-exec, expiry, revoke)
 * - https://fly.io/auth.md (flyctl token lookup: `-t`, FLY_ACCESS_TOKEN, FLY_API_TOKEN, then `~/.fly/config.yml`)
 * - https://docs.fly.io/flyctl/tokens-create-deploy (`fly tokens create deploy -a <app> -x <duration> -n <name> -j`)
 * - https://docs.fly.io/flyctl/tokens-create-readonly (`fly tokens create readonly -o <org> -x <duration>`)
 * - https://docs.fly.io/flyctl/tokens-revoke-supplied (`fly tokens revoke supplied`: revokes the FLY_API_TOKEN given)
 * - https://docs.fly.io/flyctl/auth-whoami, https://docs.fly.io/flyctl/integrating/ (FLY_API_TOKEN for automation)
 *
 * Auth modes. Primary: the login `fly auth login` holds (flyctl's own `~/.fly/config.yml`); Styx never reads that
 * file, it runs `fly` and lets the CLI use it. Advanced: a Fly.io access token pasted into the vault, handed to
 * `fly` only as FLY_API_TOKEN in the child's env (never argv). Either way the stored login is all-powerful (Fly's
 * own docs: "the output of `fly auth token` … shouldn't be used for everything"), so the agent never receives it.
 *
 * Issue: every grant mints a fresh macaroon through flyctl, capped at the grant's lifetime (≤1h for once/1h grants,
 * else an hour and re-minted), named `styx-<grantId>`:
 * - read-only grants → `fly tokens create readonly --org <app's org>`: reads one org, changes nothing (scoped: true);
 * - write / deploy / delete → `fly tokens create deploy --app <app>`: one app and its resources, but everything on
 *   that app, including `apps destroy` (scoped: false, so prod always asks with OS authentication).
 * Env: FLY_API_TOKEN (the minted token) and FLY_APP. Minting failure never falls back to the stored login.
 * Revoke: `fly tokens revoke supplied` with the minted token; its `--expiry` bounds it if that fails.
 *
 * A Fly.io login reaches every app in every org it belongs to, so a target names its app (`config.app`, the
 * project picker): one app per target, prod and staging as two apps.
 */
import { builtInDeployCommand, PROVIDER_PROJECT_REF } from '@styx/core';
import { z } from 'zod';
import { makeCredentialRef } from '../services/credential-vault';
import {
  CliAuthError,
  cliFailure,
  firstLine,
  parseStoredToken,
  readCliEntry,
  semver,
  testToHealth,
} from './cli-auth';
import { logger } from '../services/logger';
import type { CliRunResult } from './cli-runner';
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

/** Fly app and org slugs: lowercase letters, digits and dashes (core's one project-id pattern is a superset). */
const FLY_ID = PROVIDER_PROJECT_REF;

/** `fly apps list --json`: `Name` and `Organization.Slug` (older builds used lowercase keys). */
const appListSchema = z.array(
  z
    .object({
      Name: z.string().optional(),
      name: z.string().optional(),
      Organization: z.object({ Slug: z.string().optional() }).nullish(),
      organization: z.object({ slug: z.string().optional() }).nullish(),
    })
    .transform((a, ctx): ProviderProject => {
      const name = a.Name ?? a.name ?? '';
      if (!FLY_ID.test(name)) {
        ctx.addIssue({ code: 'custom', message: 'app without a valid name' });
        return z.NEVER;
      }
      const org = a.Organization?.Slug ?? a.organization?.slug ?? null;
      return { id: name, name, region: org !== null && FLY_ID.test(org) ? org : null };
    }),
);

const mintedSchema = z.object({ token: z.string().min(1) });

/** Read-only words in the second command position (`fly apps list`, `fly secrets list`, `fly machine status`). */
const FLY_READ_SUB = new Set([
  'list',
  'ls',
  'show',
  'status',
  'info',
  'view',
  'logs',
  'get',
  'validate',
  'whoami',
]);
/** Commands that only ever read (`fly status`, `fly logs`, `fly releases`). */
const FLY_READ_CMD = new Set([
  'status',
  'logs',
  'releases',
  'version',
  'doctor',
  'dashboard',
  'platform',
  'history',
]);
/** Removal verbs anywhere a subcommand sits (`machine destroy`, `volumes delete`, `secrets unset`, `ips release`). */
const FLY_DELETE_SUB = new Set(['destroy', 'delete', 'remove', 'rm', 'unset', 'release', 'revoke', 'detach']);
/**
 * Shells, tunnels and file transfer into the app's machines and private network: writes whatever follows them
 * (`fly ssh console -C …`, `fly ssh sftp get …`, `fly proxy 5432`, `fly console`), checked before the read list.
 */
const FLY_WRITE_CMD = new Set([
  'ssh',
  'sftp',
  'console',
  'proxy',
  'wireguard',
  'wg',
  'agent',
  'dig',
  'ping',
  'mcp',
]);

export class FlyAdapter implements ProviderAdapter {
  readonly provider = 'fly' as const;
  readonly authMethod = 'oauth' as const;
  readonly tools = ['fly', 'flyctl'];
  readonly projectKey = 'app';
  constructor(private readonly deps: AdapterDeps) {}

  /** `fly` is the documented name; some installs only ship `flyctl`. */
  private async bin(): Promise<string | null> {
    if (await this.deps.cli.which('fly')) return 'fly';
    if (await this.deps.cli.which('flyctl')) return 'flyctl';
    return null;
  }

  /**
   * Runs flyctl. `token` null = the CLI's own login; otherwise the token goes in FLY_API_TOKEN (the runner strips any
   * FLY_ACCESS_TOKEN from Styx's env, which would otherwise win). Output stays here: stdout can hold a token.
   */
  private async fly(args: string[], token: string | null, timeoutMs = 20_000): Promise<CliRunResult> {
    const bin = (await this.bin()) ?? 'fly';
    return this.deps.cli.run(bin, args, {
      timeoutMs,
      ...(token === null ? {} : { env: { FLY_API_TOKEN: token } }),
    });
  }

  /** The stored token (Advanced) or null for the CLI's own login. */
  private async parent(target: TargetInfo): Promise<string | null> {
    if (await readCliEntry(this.deps.vault, target)) return null;
    if (!target.credentialRef) throw new Error('not connected');
    const raw = await this.deps.vault.get(target.credentialRef);
    if (!raw) throw new Error('credential missing from keychain');
    return parseStoredToken(raw);
  }

  private async whoami(token: string | null): Promise<string> {
    const r = await this.fly(['auth', 'whoami', '--json'], token, 15_000);
    if (r.exitCode !== 0) throw cliFailure('fly', r);
    try {
      const email = (JSON.parse(r.stdout) as { email?: unknown }).email;
      if (typeof email === 'string' && email) return email;
    } catch {
      /* older builds print the email as text */
    }
    const line = firstLine(r.stdout.trim());
    if (!line) throw new CliAuthError('fly: not logged in', true);
    return line;
  }

  private async apps(token: string | null): Promise<ProviderProject[]> {
    const r = await this.fly(['apps', 'list', '--json'], token);
    if (r.exitCode !== 0) throw cliFailure('fly', r);
    let rows: unknown;
    try {
      rows = JSON.parse(r.stdout || '[]');
    } catch {
      throw new Error('fly returned an app list Styx could not read');
    }
    const parsed = appListSchema.safeParse(rows);
    if (!parsed.success) throw new Error('fly returned an app list Styx could not read');
    return parsed.data;
  }

  async connect(input: ConnectInput, targetId: string) {
    if (input.method === 'cli') return this.connectCli(input, targetId);
    if (input.method !== 'token') throw new Error('Fly.io connect expects a token or the fly CLI login');
    const token = input.token.trim();
    const cfg = input.config ?? {};
    const who = await this.whoami(token);
    const picked = pickProjectOf('fly', await this.apps(token), cfg['app']);
    if (!picked.ok) throw new Error(picked.error);
    const ref = makeCredentialRef('fly', targetId, 'oauth');
    await this.deps.vault.set(ref, JSON.stringify({ token }));
    return {
      credentialRef: ref,
      config: { ...cfg, app: picked.project.id, account: who },
      label: input.name ?? 'Fly.io',
    };
  }

  private async connectCli(input: Extract<ConnectInput, { method: 'cli' }>, targetId: string) {
    const who = await this.whoami(null);
    const wanted = input.account.trim();
    if (wanted && wanted !== 'cli' && wanted.toLowerCase() !== who.toLowerCase())
      throw new Error(`fly CLI is logged in as ${who}, not ${wanted}`);
    const cfg = input.config ?? {};
    const picked = pickProjectOf('fly', await this.apps(null), cfg['app']);
    if (!picked.ok) throw new Error(picked.error);
    const ref = makeCredentialRef('fly', targetId, 'cli');
    await this.deps.vault.set(ref, JSON.stringify({ kind: 'cli', account: who }));
    return {
      credentialRef: ref,
      config: { ...cfg, app: picked.project.id, account: who },
      label: input.name ?? 'Fly.io',
    };
  }

  async cliStatus(): Promise<CliStatus> {
    const loginCommand = 'fly auth login';
    const bin = await this.bin();
    const binary = bin === null ? null : await this.deps.cli.which(bin);
    if (bin === null || binary === null)
      return { installed: false, binary: null, version: null, loginCommand, accounts: [] };
    const v = await this.deps.cli.run(bin, ['version'], { timeoutMs: 10_000 });
    const version = v.exitCode === 0 ? semver(`${v.stdout}\n${v.stderr}`) : null;
    const who = await this.whoami(null).catch(() => null);
    return {
      installed: true,
      binary,
      version,
      loginCommand,
      accounts: who === null ? [] : [{ id: who, label: who, active: true }],
    };
  }

  cliLoginCommand(): CliCommand {
    return { bin: 'fly', args: ['auth', 'login'] };
  }

  /** `fly deploy --app <app>` (core's `builtInDeployCommand`, so Settings shows exactly what runs). */
  deployCommand(target: TargetInfo): CliCommand {
    return builtInDeployCommand(target) ?? { bin: 'fly', args: ['deploy'] };
  }

  async listProjects(source: ProjectSource): Promise<ProviderProject[]> {
    const token =
      source.kind === 'token'
        ? source.token.trim()
        : source.kind === 'cli'
          ? null
          : await this.parent(source.target);
    return this.apps(token);
  }

  async test(target: TargetInfo): Promise<TestResult> {
    try {
      const token = await this.parent(target);
      const who = await this.whoami(token);
      const picked = pickProjectOf('fly', await this.apps(token), target.config['app']);
      if (!picked.ok) return { ok: false, error: picked.error, needsProject: true };
      return { ok: true, identity: `${picked.project.id} (${who})` };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async health(target: TargetInfo): Promise<HealthResult> {
    const t = await this.test(target);
    if (!t.ok && t.needsProject === true) return { ok: false, expired: false, error: t.error };
    return testToHealth(t);
  }

  /** The app a target acts on: the chosen one (checked against the login when it isn't a plain name), else the only one. */
  private async app(target: TargetInfo, token: string | null): Promise<{ app: string; org: string | null }> {
    const chosen = target.config['app'];
    const apps = await this.apps(token);
    const picked = pickProjectOf('fly', apps, chosen);
    if (!picked.ok) throw new Error(picked.error);
    return { app: picked.project.id, org: picked.project.region };
  }

  async issue(grant: GrantInfo, target: TargetInfo): Promise<IssuedCredential> {
    const now = this.deps.now();
    // Never longer than an hour, whatever the grant: a session or always grant is re-minted as it runs out.
    const expiresAt = Math.min(expiryFor(grant, now) ?? now + HOUR, now + HOUR);
    const seconds = Math.max(60, Math.ceil((expiresAt - now) / 1000));
    const token = await this.parent(target);
    // The app list doubles as the check that the login still reaches the app (and names its org for read grants).
    const { app, org } = await this.app(target, token);
    const readOnly = this.issuesScoped(grant.scope);
    if (readOnly && org === null) throw new Error(`fly did not say which organization ${app} belongs to`);
    const kind = readOnly ? ['readonly', '--org', org ?? ''] : ['deploy', '--app', app];
    const r = await this.fly(
      ['tokens', 'create', ...kind, '--expiry', `${seconds}s`, '--name', `styx-${grant.id}`, '--json'],
      token,
    );
    if (r.exitCode !== 0) throw cliFailure('fly', r);
    let minted: string;
    try {
      minted = mintedSchema.parse(JSON.parse(r.stdout)).token.trim();
    } catch {
      throw new Error('fly returned a token Styx could not read');
    }
    return {
      kind: 'env',
      env: { FLY_API_TOKEN: minted, FLY_APP: app },
      expiresAt: Math.min(expiresAt, now + seconds * 1000),
      scoped: readOnly,
      handle: 'minted',
    };
  }

  /** Revokes the minted macaroon upstream; on failure its own `--expiry` still ends it. */
  async revoke(issued: IssuedCredential): Promise<void> {
    if (issued.kind !== 'env' || issued.handle !== 'minted') return;
    const token = issued.env['FLY_API_TOKEN'];
    if (!token) return;
    const r = await this.fly(['tokens', 'revoke', 'supplied'], token, 15_000).catch(() => null);
    // Exit code only, never output: the token's own `--expiry` still ends it.
    if (r === null || r.exitCode !== 0)
      logger.warn('fly: revoking a minted token failed', { exitCode: r?.exitCode ?? null });
  }

  /** Only read-only grants get a narrower token (an org read-only macaroon); a deploy token can do anything to its app. */
  issuesScoped(scope: readonly Scope[]): boolean {
    return scope.length > 0 && scope.every((s) => s === 'read');
  }

  /**
   * The app flyctl itself will act on: `-a X`, `-aX`, `--app X`, `--app=X` (the last one wins, as in pflag). A write
   * credential is a deploy token for one app, so `BrokerHost.pickTarget` may route on it.
   */
  projectOfCommand(argv: string[]): string | null {
    let app: string | null = null;
    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i] ?? '';
      if (a === '--') break;
      if (a === '-a' || a === '--app') app = argv[i + 1] ?? null;
      else if (a.startsWith('--app=')) app = a.slice('--app='.length);
      else if (/^-a[^-]/.test(a)) app = a.slice(2).replace(/^=/, '');
    }
    return app;
  }

  scopeOfCommand(argv: string[]): Scope[] {
    return classifyArgv(argv, (head) => this.classify(head, argv));
  }

  private classify([cmd, sub]: string[], argv: string[]): Scope {
    // Shells and tunnels pass their arguments on: a trailing `--help` there is not flyctl's.
    if (!(cmd !== undefined && FLY_WRITE_CMD.has(cmd)) && strictHelp(argv)) return 'read';
    if (cmd === undefined) return 'write';
    if (cmd === 'destroy' || (sub !== undefined && FLY_DELETE_SUB.has(sub))) return 'delete';
    if (
      cmd === 'deploy' ||
      cmd === 'launch' ||
      cmd === 'restart' ||
      sub === 'restart' ||
      (cmd === 'image' && sub === 'update') ||
      (cmd === 'secrets' && sub === 'deploy') ||
      (cmd === 'releases' && sub === 'rollback')
    )
      return 'deploy';
    if (FLY_WRITE_CMD.has(cmd)) return 'write';
    // `fly tokens create` mints credentials and `fly auth token` prints one: neither is a read.
    if (cmd === 'tokens' && sub !== 'list') return 'write';
    if (cmd === 'auth') return sub === 'whoami' ? 'read' : 'write';
    if (
      (FLY_READ_CMD.has(cmd) && (sub === undefined || FLY_READ_SUB.has(sub) || cmd === 'platform')) ||
      (sub !== undefined && FLY_READ_SUB.has(sub)) ||
      (cmd === 'config' && (sub === 'show' || sub === 'validate' || sub === 'env'))
    )
      return 'read';
    return 'write'; // unknown verbs fail closed
  }
}

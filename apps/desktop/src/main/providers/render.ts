/**
 * Render (issue #25).
 *
 * Sources (checked 2026-10-15):
 * - https://render.com/docs/cli (`render login`, RENDER_API_KEY "always takes precedence over CLI tokens", "API keys
 *   do not periodically expire", `deploys create [SERVICE_ID] --wait --confirm`, `-o json|yaml|text`, `ssh`, `psql`)
 * - https://github.com/render-oss/cli/blob/main/pkg/config/config.go (`~/.render/cli.yaml`: `api.key`,
 *   `api.expires_at`, `user_email`, `workspace_name`; RENDER_CLI_CONFIG_PATH moves it)
 * - https://api-docs.render.com/reference/authentication ("An API key provides access to all workspaces you belong
 *   to"), https://feedback.render.com/features/p/api-token-scoped-per-workspace-for-soc-2-compliance (no scoping)
 * - https://api-docs.render.com/reference/list-services, https://api-docs.render.com/reference/list-owners
 *
 * Auth modes. Primary: the token `render login` keeps in the CLI's `cli.yaml`, read on every use, never copied.
 * Advanced: an API key pasted into the vault.
 *
 * Render cannot narrow a credential. An API key (and the CLI's login token) reaches every workspace and service the
 * account belongs to, can deploy, change environment variables, suspend and delete, and Render has no API to mint a
 * shorter-lived or narrower one. So `issue()` hands the stored token over as RENDER_API_KEY with `scoped: false`
 * and no `issuesScoped()`: every grant on a prod Render target asks with OS authentication, reads included.
 * `revoke()` has nothing to revoke upstream; Styx stops delivering the token.
 *
 * A target names the service it deploys (`config.serviceId`, the project picker): `render deploys create <id>`.
 */
import { builtInDeployCommand, PROVIDER_PROJECT_REF } from '@styx/core';
import { z } from 'zod';
import { makeCredentialRef } from '../services/credential-vault';
import {
  CliAuthError,
  cliInstall,
  parseStoredToken,
  readCliEntry,
  renderConfigPath,
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
import { classifyArgv, strictHelp } from './types';

const API = 'https://api.render.com/v1';
/** Service ids (`srv-…`): core's project-id pattern. */
const RENDER_ID = PROVIDER_PROJECT_REF;

const servicesSchema = z.array(
  z.object({
    service: z.object({
      id: z.string(),
      name: z.string(),
      type: z.string().nullish(),
      serviceDetails: z.object({ region: z.string().nullish() }).passthrough().nullish(),
    }),
  }),
);
const ownersSchema = z.array(
  z.object({ owner: z.object({ name: z.string().nullish(), email: z.string().nullish() }) }),
);

export interface RenderCliConfig {
  key: string | null;
  /** Epoch ms, or null when the file names none (an API key saved there never expires). */
  expiresAt: number | null;
  email: string | null;
  workspace: string | null;
}

const unquote = (v: string): string => v.trim().replace(/^(['"])(.*)\1$/, '$2');

/**
 * The few keys Styx needs from `cli.yaml` (`api.key`, `api.expires_at`, `user_email`, `workspace_name`). A line
 * parser rather than a YAML library: the file is flat, and anything else in it is ignored, never echoed.
 */
export function parseRenderCliConfig(text: string): RenderCliConfig {
  const out: RenderCliConfig = { key: null, expiresAt: null, email: null, workspace: null };
  let inApi = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(raw)) continue;
    const indented = /^\s/.test(raw);
    const kv = /^\s*([A-Za-z_]+):\s*(.*)$/.exec(raw);
    if (!kv) continue;
    const key = kv[1] ?? '';
    const value = unquote(kv[2] ?? '');
    if (!indented) {
      inApi = key === 'api';
      if (key === 'user_email' && value) out.email = value;
      if (key === 'workspace_name' && value) out.workspace = value;
      continue;
    }
    if (!inApi) continue;
    if (key === 'key' && value) out.key = value;
    if (key === 'expires_at' && /^\d+$/.test(value)) {
      const n = Number(value);
      out.expiresAt = n === 0 ? null : n < 1e12 ? n * 1000 : n;
    }
  }
  return out;
}

/** Read-only words in the second command position (`deploys list`, `jobs list`, `blueprints validate`). */
const RENDER_READ_SUB = new Set(['list', 'ls', 'get', 'show', 'validate', 'status', 'current']);
/** Commands that list or show when given no subcommand (`render services`, `render deploys`, `render logs`). */
const RENDER_READ_CMD = new Set([
  'services',
  'deploys',
  'workspaces',
  'logs',
  'projects',
  'environments',
  'whoami',
  'version',
  'jobs',
  'blueprints',
]);
/** Removal verbs as a subcommand. */
const RENDER_DELETE_SUB = new Set(['delete', 'rm', 'remove', 'destroy']);
/** Shells into services and databases (`ssh`, `psql`, `kv-cli`): writes whatever follows. */
const RENDER_WRITE_CMD = new Set(['ssh', 'psql', 'kv-cli', 'redis-cli', 'login', 'logout', 'skills']);

/** `-o interactive` / `--output=interactive` / `-ointeractive`: the TUI, whose lists carry actions. */
function interactiveOutput(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? '';
    const v =
      a === '-o' || a === '--output'
        ? argv[i + 1]
        : a.startsWith('--output=')
          ? a.slice('--output='.length)
          : /^-o[^-]/.test(a)
            ? a.slice(2)
            : undefined;
    if (v !== undefined && v.replace(/^=/, '').toLowerCase() === 'interactive') return true;
  }
  return false;
}

export class RenderAdapter implements ProviderAdapter {
  readonly provider = 'render' as const;
  readonly authMethod = 'oauth' as const;
  readonly tools = ['render'];
  readonly projectKey = 'serviceId';
  constructor(private readonly deps: AdapterDeps) {}

  // --- api ---------------------------------------------------------------------

  private async get<T>(token: string, path: string, schema: z.ZodType<T>): Promise<T> {
    let r: Response;
    try {
      r = await this.deps.fetch(`${API}${path}`, {
        headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
      });
    } catch {
      throw new Error('Could not reach Render');
    }
    if (!r.ok) throw new Error(`Render rejected the token (${r.status})`);
    const parsed = schema.safeParse(await r.json().catch(() => null));
    if (!parsed.success) throw new Error('Render returned something Styx could not read');
    return parsed.data;
  }

  private async services(token: string): Promise<ProviderProject[]> {
    const rows = await this.get(token, '/services?limit=100', servicesSchema);
    return rows
      .filter(({ service }) => RENDER_ID.test(service.id))
      .map(({ service }) => ({
        id: service.id,
        name: service.name,
        region: service.serviceDetails?.region ?? service.type ?? null,
      }));
  }

  private async identity(token: string): Promise<string> {
    const owners = await this.get(token, '/owners?limit=20', ownersSchema);
    const first = owners.find((o) => o.owner.email) ?? owners[0];
    return first?.owner.email ?? first?.owner.name ?? 'Render';
  }

  // --- cli mode ----------------------------------------------------------------

  private async readCli(): Promise<RenderCliConfig | null> {
    const raw = await this.deps.cli.readFile(renderConfigPath(this.deps.cli));
    return raw === null ? null : parseRenderCliConfig(raw);
  }

  /** The CLI's token, read on every use. An expired one gets one chance to refresh through the CLI itself. */
  private async cliToken(): Promise<{ token: string; expiresAt: number | null }> {
    const now = this.deps.now();
    let c = await this.readCli();
    if (c?.key && c.expiresAt !== null && c.expiresAt <= now + 60_000) {
      await this.deps.cli
        .run('render', ['workspaces', '-o', 'json'], { timeoutMs: 15_000 })
        .catch(() => null);
      c = await this.readCli();
      if (c?.key && c.expiresAt !== null && c.expiresAt <= now + 60_000)
        throw new CliAuthError('render CLI login has expired (run `render login`)', true);
    }
    if (!c?.key) throw new CliAuthError('render CLI is not logged in (run `render login`)', true);
    return { token: c.key, expiresAt: c.expiresAt };
  }

  private async token(target: TargetInfo): Promise<{ token: string; expiresAt: number | null }> {
    if (await readCliEntry(this.deps.vault, target)) return this.cliToken();
    if (!target.credentialRef) throw new Error('not connected');
    const raw = await this.deps.vault.get(target.credentialRef);
    if (!raw) throw new Error('credential missing from keychain');
    return { token: parseStoredToken(raw), expiresAt: null };
  }

  // --- connect -----------------------------------------------------------------

  async connect(input: ConnectInput, targetId: string) {
    if (input.method === 'cli') return this.connectCli(input, targetId);
    if (input.method !== 'token')
      throw new Error('Render connect expects an API key or the render CLI login');
    const token = input.token.trim();
    const cfg = input.config ?? {};
    const who = await this.identity(token);
    const picked = pickProjectOf('render', await this.services(token), cfg['serviceId']);
    if (!picked.ok) throw new Error(picked.error);
    const ref = makeCredentialRef('render', targetId, 'oauth');
    await this.deps.vault.set(ref, JSON.stringify({ token }));
    return {
      credentialRef: ref,
      config: { ...cfg, serviceId: picked.project.id, account: who },
      label: input.name ?? 'Render',
    };
  }

  private async connectCli(input: Extract<ConnectInput, { method: 'cli' }>, targetId: string) {
    const { token } = await this.cliToken();
    const cfg = input.config ?? {};
    const picked = pickProjectOf('render', await this.services(token), cfg['serviceId']);
    if (!picked.ok) throw new Error(picked.error);
    const ref = makeCredentialRef('render', targetId, 'cli');
    const account = input.account.trim() || 'cli';
    await this.deps.vault.set(ref, JSON.stringify({ kind: 'cli', account }));
    return {
      credentialRef: ref,
      config: { ...cfg, serviceId: picked.project.id, account },
      label: input.name ?? 'Render',
    };
  }

  async cliStatus(): Promise<CliStatus> {
    const loginCommand = 'render login';
    const { binary, version } = await cliInstall(this.deps.cli, 'render', ['--version'], (out) =>
      semver(out),
    );
    if (!binary) return { installed: false, binary: null, version: null, loginCommand, accounts: [] };
    const c = await this.readCli();
    if (!c?.key) return { installed: true, binary, version, loginCommand, accounts: [] };
    const expired = c.expiresAt !== null && c.expiresAt <= this.deps.now();
    return {
      installed: true,
      binary,
      version,
      loginCommand,
      accounts: [
        {
          id: 'cli',
          label: c.email ?? 'render CLI login',
          active: !expired,
          ...(c.workspace !== null ? { detail: c.workspace } : expired ? { detail: 'login expired' } : {}),
        },
      ],
    };
  }

  cliLoginCommand(): CliCommand {
    return { bin: 'render', args: ['login'] };
  }

  /** `render deploys create <serviceId> --confirm --wait` (core's `builtInDeployCommand`). */
  deployCommand(target: TargetInfo): CliCommand {
    return builtInDeployCommand(target) ?? { bin: 'render', args: ['deploys', 'create'] };
  }

  async listProjects(source: ProjectSource): Promise<ProviderProject[]> {
    const token =
      source.kind === 'token'
        ? source.token.trim()
        : source.kind === 'cli'
          ? (await this.cliToken()).token
          : (await this.token(source.target)).token;
    return this.services(token);
  }

  async test(target: TargetInfo): Promise<TestResult> {
    try {
      const { token } = await this.token(target);
      const picked = pickProjectOf('render', await this.services(token), target.config['serviceId']);
      if (!picked.ok) return { ok: false, error: picked.error, needsProject: true };
      return { ok: true, identity: `${picked.project.name} (${picked.project.id})` };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async health(target: TargetInfo): Promise<HealthResult> {
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
    return testToHealth(t);
  }

  // --- issue / revoke ----------------------------------------------------------

  async issue(grant: GrantInfo, target: TargetInfo): Promise<IssuedCredential> {
    const { token, expiresAt: tokenExpiry } = await this.token(target);
    // Fail closed like Supabase: a target that names no service gets one only when the account has exactly one.
    const chosen = target.config['serviceId'];
    if (!(typeof chosen === 'string' && RENDER_ID.test(chosen))) {
      const picked = pickProjectOf('render', await this.services(token), chosen);
      if (!picked.ok) throw new Error(picked.error);
    }
    const expiresAt =
      tokenExpiry === null
        ? grant.expiresAt
        : grant.expiresAt === null
          ? tokenExpiry
          : Math.min(grant.expiresAt, tokenExpiry);
    // RENDER_OUTPUT keeps the CLI out of its interactive TUI (where a list offers deploy / restart actions) unless
    // argv asks for it, which `scopeOfCommand` then treats as a write.
    return { kind: 'env', env: { RENDER_API_KEY: token, RENDER_OUTPUT: 'text' }, expiresAt, scoped: false };
  }

  async revoke(): Promise<void> {
    /* Render has no narrower or revocable credential to mint: delivery simply stops */
  }

  scopeOfCommand(argv: string[]): Scope[] {
    return classifyArgv(argv, (head) => this.classify(head, argv));
  }

  private classify([cmd, sub]: string[], argv: string[]): Scope {
    // `render ssh srv -- sh -c x --help`: shells pass their arguments on, so a trailing `--help` is not render's.
    if (!(cmd !== undefined && RENDER_WRITE_CMD.has(cmd)) && strictHelp(argv)) return 'read';
    if (cmd === undefined) return 'write';
    if (cmd === 'delete' || (sub !== undefined && RENDER_DELETE_SUB.has(sub))) return 'delete';
    if (
      (cmd === 'deploys' && sub === 'create') ||
      cmd === 'restart' ||
      sub === 'restart' ||
      (cmd === 'blueprints' && sub === 'launch')
    )
      return 'deploy';
    if (RENDER_WRITE_CMD.has(cmd)) return 'write';
    // The interactive TUI can deploy, restart or suspend from a list: never a read.
    if (interactiveOutput(argv)) return 'write';
    if (
      (RENDER_READ_CMD.has(cmd) && (sub === undefined || RENDER_READ_SUB.has(sub))) ||
      (cmd === 'workspace' && sub === 'current')
    )
      return 'read';
    return 'write'; // unknown verbs fail closed
  }
}

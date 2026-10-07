import { copy, fill, PROVIDER_PROJECT_REF } from '@styx/core';
import { z } from 'zod';
import { makeCredentialRef } from '../services/credential-vault';
import {
  CliAuthError,
  cliInstall,
  firstLine,
  readCliEntry,
  semver,
  testToHealth,
  supabaseTokenPath,
} from './cli-auth';
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
import { commandHead, isHelp } from './types';

const SUPABASE_READ_SUB = new Set([
  'list',
  'ls',
  'get',
  'status',
  'diff',
  'dump',
  'lint',
  'inspect',
  'show',
  'fetch',
]);

/** Project refs travel into env (`SUPABASE_PROJECT_REF`) and argv (`--project-ref`): core's one ref pattern. */
const SUPABASE_REF = PROVIDER_PROJECT_REF;

/**
 * `GET /v1/projects`: `ref` is the project's id (older responses carry it only as `id`). Anything else in a row is
 * ignored; a row without a usable ref fails the whole list rather than being guessed at.
 */
const projectListSchema = z.array(
  z
    .object({
      id: z.string().optional(),
      ref: z.string().optional(),
      name: z.string(),
      region: z.string().nullish(),
    })
    .transform((p, ctx): ProviderProject => {
      const ref = p.ref ?? p.id ?? '';
      if (!SUPABASE_REF.test(ref)) {
        ctx.addIssue({ code: 'custom', message: 'project without a valid ref' });
        return z.NEVER;
      }
      return { id: ref, name: p.name, region: p.region ?? null };
    }),
);

type Picked = { ok: true; project: ProviderProject } | { ok: false; error: string };

/**
 * Which project a target acts on: the ref it was given, or the account's only project. Never the first of several
 * (issue #5: prod and staging targets both landed on whichever project the API listed first).
 */
export function pickProject(projects: readonly ProviderProject[], chosen: unknown): Picked {
  if (typeof chosen === 'string' && chosen !== '') {
    const project = projects.find((p) => p.id === chosen);
    return project
      ? { ok: true, project }
      : { ok: false, error: fill(copy.connect.project.gone, { ref: chosen }) };
  }
  if (projects.length === 1 && projects[0]) return { ok: true, project: projects[0] };
  return {
    ok: false,
    error: projects.length === 0 ? copy.connect.project.none : copy.connect.project.choose,
  };
}

/**
 * Supabase. Primary: the login `supabase login` holds — `~/.supabase/access-token` (the CLI's file store), else the
 * OS keyring entry the CLI writes (read via @napi-rs/keyring so the keychain prompt is attributed to Styx). Advanced: a personal access token pasted into the vault (PKCE OAuth needs a registered
 * Styx OAuth app). Tokens are read on every use, never copied.
 */
export class SupabaseAdapter implements ProviderAdapter {
  readonly provider = 'supabase' as const;
  readonly authMethod = 'oauth' as const;
  readonly tools = ['supabase'];
  constructor(private readonly deps: AdapterDeps) {}

  async connect(input: ConnectInput, targetId: string) {
    if (input.method === 'cli') return this.connectCli(input, targetId);
    if (input.method !== 'token')
      throw new Error('Supabase connect expects a token or the supabase CLI login');
    const cfg = input.config ?? {};
    const picked = pickProject(await this.projects(input.token.trim()), cfg['ref']);
    if (!picked.ok) throw new Error(picked.error);
    const ref = makeCredentialRef('supabase', targetId, 'oauth');
    await this.deps.vault.set(ref, JSON.stringify({ token: input.token.trim() }));
    return {
      credentialRef: ref,
      config: { ...cfg, ref: picked.project.id },
      label: input.name ?? 'Supabase',
    };
  }

  // --- cli mode --------------------------------------------------------------

  private async cliToken(): Promise<string> {
    const file = await this.deps.cli.readFile(supabaseTokenPath(this.deps.cli));
    const fromFile = file === null ? '' : firstLine(file);
    if (fromFile) return fromFile;
    // The CLI prefers the OS keyring when one exists (go-keyring: service "Supabase CLI", account "access-token").
    // Read through @napi-rs/keyring so the keychain ACL prompt names Styx, never a generic `security` binary.
    const fromKeyring = await this.deps.cli.readKeychain('Supabase CLI', 'access-token');
    if (fromKeyring) return fromKeyring.trim();
    throw new CliAuthError('supabase CLI is not logged in (run `supabase login`)', true);
  }

  private async connectCli(input: Extract<ConnectInput, { method: 'cli' }>, targetId: string) {
    const cfg = input.config ?? {};
    const picked = pickProject(await this.projects(await this.cliToken()), cfg['ref']);
    if (!picked.ok) throw new Error(picked.error);
    const ref = makeCredentialRef('supabase', targetId, 'cli');
    const account = input.account.trim() || 'cli';
    await this.deps.vault.set(ref, JSON.stringify({ kind: 'cli', account }));
    return {
      credentialRef: ref,
      config: { ...cfg, ref: picked.project.id, account },
      label: input.name ?? 'Supabase',
    };
  }

  async cliStatus(): Promise<CliStatus> {
    const loginCommand = 'supabase login';
    const { binary, version } = await cliInstall(this.deps.cli, 'supabase', ['--version'], (out) =>
      semver(out),
    );
    if (!binary) return { installed: false, binary: null, version: null, loginCommand, accounts: [] };
    const file = await this.deps.cli.readFile(supabaseTokenPath(this.deps.cli));
    const hasFile = file !== null && firstLine(file) !== '';
    // `projects list` succeeds only with a working login (file, keyring or SUPABASE_ACCESS_TOKEN); output is names + refs.
    const list = await this.deps.cli.run('supabase', ['projects', 'list', '--output', 'json'], {
      timeoutMs: 20_000,
    });
    let count: number | null = null;
    if (list.exitCode === 0) {
      try {
        const rows = JSON.parse(list.stdout || '[]') as unknown;
        count = Array.isArray(rows) ? rows.length : null;
      } catch {
        count = null;
      }
    }
    const loggedIn = hasFile || list.exitCode === 0;
    const accounts = loggedIn
      ? [
          {
            id: 'cli',
            label: 'supabase CLI login',
            active: list.exitCode === 0,
            detail:
              count === null
                ? hasFile
                  ? 'token file'
                  : 'keyring'
                : `${count} project${count === 1 ? '' : 's'}`,
          },
        ]
      : [];
    return { installed: true, binary, version, loginCommand, accounts };
  }

  cliLoginCommand(): CliCommand {
    return { bin: 'supabase', args: ['login'] };
  }

  async health(target: TargetInfo): Promise<HealthResult> {
    const entry = await readCliEntry(this.deps.vault, target).catch((e: Error) => {
      throw new CliAuthError(e.message, false);
    });
    if (!entry) {
      const t = await this.test(target);
      // An unchosen project is not an expiry, whatever its message says.
      if (!t.ok && t.needsProject === true) return { ok: false, expired: false, error: t.error };
      return testToHealth(t);
    }
    try {
      const picked = pickProject(await this.projects(await this.cliToken()), target.config['ref']);
      // The login works; an unchosen or vanished project is not an expiry (no Reconnect banner), only unusable.
      if (!picked.ok) return { ok: false, expired: false, error: picked.error };
      return { ok: true, identity: `${picked.project.name} (${picked.project.id})` };
    } catch (e) {
      return {
        ok: false,
        expired:
          e instanceof CliAuthError ? e.expired : /rejected the token \(40[13]\)/.test((e as Error).message),
        error: (e as Error).message,
      };
    }
  }

  private async projects(token: string): Promise<ProviderProject[]> {
    let r: Response;
    try {
      r = await this.deps.fetch('https://api.supabase.com/v1/projects', {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // A fixed message: whatever the network layer said (URLs, headers) never reaches the UI, audit or logs.
      throw new Error('Could not reach Supabase to list projects');
    }
    if (!r.ok) throw new Error(`Supabase rejected the token (${r.status})`);
    const parsed = projectListSchema.safeParse(await r.json().catch(() => null));
    if (!parsed.success) throw new Error('Supabase returned a project list Styx could not read');
    return parsed.data;
  }

  readonly projectKey = 'ref';

  /** The projects a login reaches, for the connect flow's picker and Settings' "Choose project". */
  async listProjects(source: ProjectSource): Promise<ProviderProject[]> {
    const token =
      source.kind === 'token'
        ? source.token.trim()
        : source.kind === 'cli'
          ? await this.cliToken()
          : await this.token(source.target);
    return this.projects(token);
  }

  async test(target: TargetInfo): Promise<TestResult> {
    try {
      const picked = pickProject(await this.projects(await this.token(target)), target.config['ref']);
      if (!picked.ok) return { ok: false, error: picked.error, needsProject: true };
      return { ok: true, identity: `${picked.project.name} (${picked.project.id})` };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  private async token(target: TargetInfo): Promise<string> {
    if (await readCliEntry(this.deps.vault, target)) return this.cliToken();
    if (!target.credentialRef) throw new Error('not connected');
    const raw = await this.deps.vault.get(target.credentialRef);
    if (!raw) throw new Error('credential missing from keychain');
    return (JSON.parse(raw) as { token: string }).token;
  }

  async issue(grant: GrantInfo, target: TargetInfo): Promise<IssuedCredential> {
    const token = await this.token(target);
    // Fail closed: a target that names no project gets one only when the account has exactly one; with several the
    // grant is refused rather than pointed at whichever project the API lists first.
    const chosen = target.config['ref'];
    let projectRef: string;
    if (typeof chosen === 'string' && SUPABASE_REF.test(chosen)) projectRef = chosen;
    else {
      const picked = pickProject(await this.projects(token), chosen);
      if (!picked.ok) throw new Error(picked.error);
      projectRef = picked.project.id;
    }
    const env: Record<string, string> = { SUPABASE_ACCESS_TOKEN: token, SUPABASE_PROJECT_REF: projectRef };
    return { kind: 'env', env, expiresAt: grant.expiresAt, scoped: false };
  }

  async revoke(): Promise<void> {}

  scopeOfCommand(argv: string[]): Scope[] {
    const [cmd, sub, sub2] = commandHead(argv);
    if (
      (cmd === 'db' && sub === 'reset') ||
      (cmd === 'projects' && sub === 'delete') ||
      (cmd === 'branches' && sub === 'delete') ||
      sub === 'delete' ||
      sub === 'rm' ||
      sub === 'unset'
    )
      return ['delete'];
    if (cmd === 'functions' && sub === 'deploy') return ['deploy'];
    if (
      (cmd === 'db' && (sub === 'push' || sub === 'seed')) ||
      (cmd === 'migration' && (sub === 'up' || sub === 'repair')) ||
      (cmd === 'secrets' && sub === 'set') ||
      sub === 'create' ||
      sub === 'update' ||
      sub2 === 'push'
    )
      return ['write'];
    if (
      isHelp(argv) ||
      cmd === 'login' ||
      cmd === 'status' ||
      (sub !== undefined && SUPABASE_READ_SUB.has(sub)) ||
      (cmd === 'gen' && sub === 'types')
    )
      return ['read'];
    return ['write']; // unknown verbs fail closed
  }
}

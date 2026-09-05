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
  ProviderAdapter,
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
    const projects = await this.projects(input.token.trim());
    const ref = makeCredentialRef('supabase', targetId, 'oauth');
    await this.deps.vault.set(ref, JSON.stringify({ token: input.token.trim() }));
    const cfg = input.config ?? {};
    const projectRef = (cfg['ref'] as string | undefined) ?? projects[0]?.id;
    return {
      credentialRef: ref,
      config: { ...cfg, ...(projectRef ? { ref: projectRef } : {}) },
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
    const projects = await this.projects(await this.cliToken());
    const ref = makeCredentialRef('supabase', targetId, 'cli');
    const account = input.account.trim() || 'cli';
    await this.deps.vault.set(ref, JSON.stringify({ kind: 'cli', account }));
    const cfg = input.config ?? {};
    const projectRef = (cfg['ref'] as string | undefined) ?? projects[0]?.id;
    return {
      credentialRef: ref,
      config: { ...cfg, ...(projectRef ? { ref: projectRef } : {}), account },
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
    if (!entry) return testToHealth(await this.test(target));
    try {
      const ps = await this.projects(await this.cliToken());
      return { ok: true, identity: `${ps.length} projects` };
    } catch (e) {
      return {
        ok: false,
        expired:
          e instanceof CliAuthError ? e.expired : /rejected the token \(40[13]\)/.test((e as Error).message),
        error: (e as Error).message,
      };
    }
  }

  private async projects(token: string): Promise<{ id: string; name: string }[]> {
    const r = await this.deps.fetch('https://api.supabase.com/v1/projects', {
      headers: { Authorization: `Bearer ${token}` },
    });
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
    if (await readCliEntry(this.deps.vault, target)) return this.cliToken();
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

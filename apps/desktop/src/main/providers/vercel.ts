import { makeCredentialRef } from '../services/credential-vault';
import {
  CliAuthError,
  cliInstall,
  firstLine,
  readCliEntry,
  semver,
  testToHealth,
  vercelAuthPaths,
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

const VERCEL_READ = new Set(['ls', 'list', 'inspect', 'logs', 'whoami', 'help', 'bisect']);
const VERCEL_READ_SUB = new Set(['ls', 'list', 'inspect', 'pull', 'get', 'logs', 'status']);

const CURL_LONG_BODY = /^(--data(-[a-z]+)?|--form(-string)?|--json|--upload-file)(=|$)/;
/** curl short options that take a value; `d`/`F`/`T` carry a body, `X` the method. */
const CURL_VALUE_FLAGS = 'XdFTHAbcCeEKmoruUwyYz';

/**
 * `vercel curl` proxies an arbitrary authenticated API call (M-2): the HTTP method (`-X`/`--request`, attached or
 * clustered like `-sXDELETE`) and any body flag (`-d`/`--data*`, `-F`/`--form*`, `--json`, `-T`/`--upload-file`,
 * clustered like `-sd '{}'` or attached like `-Fname=@x`) decide. DELETE → delete; any non-GET method or a body
 * → write; a plain GET → read.
 */
function curlScope(rest: string[]): Scope[] {
  let method = 'GET';
  let hasBody = false;
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i] ?? '';
    if (a === '--request') method = (rest[i + 1] ?? '').toUpperCase();
    else if (a.startsWith('--request=')) method = a.slice('--request='.length).toUpperCase();
    else if (CURL_LONG_BODY.test(a)) hasBody = true;
    else if (a.startsWith('-') && !a.startsWith('--')) {
      const { flags, value, consumedNext } = shortFlags(a, rest[i + 1], CURL_VALUE_FLAGS);
      if (flags.some((f) => f === 'd' || f === 'F' || f === 'T')) hasBody = true;
      if (flags.at(-1) === 'X') method = (value ?? '').toUpperCase();
      if (consumedNext) i += 1;
    }
  }
  if (method === 'DELETE') return ['delete'];
  if (method === 'GET' && !hasBody) return ['read'];
  return ['write'];
}

/**
 * Vercel. Primary: the token `vercel login` stored in the CLI's own auth store (`auth.json`, read on every use, never
 * copied or modified). Advanced: a dashboard token pasted into the vault. No per-grant scoping API; scope enforced at the shim.
 */
export class VercelAdapter implements ProviderAdapter {
  readonly provider = 'vercel' as const;
  readonly authMethod = 'oauth' as const;
  readonly tools = ['vercel'];
  constructor(private readonly deps: AdapterDeps) {}

  async connect(input: ConnectInput, targetId: string) {
    if (input.method === 'cli') return this.connectCli(input, targetId);
    if (input.method !== 'token') throw new Error('Vercel connect expects a token or the vercel CLI login');
    const me = await this.whoami(input.token.trim());
    const ref = makeCredentialRef('vercel', targetId, 'oauth');
    await this.deps.vault.set(ref, JSON.stringify({ token: input.token.trim() }));
    return {
      credentialRef: ref,
      config: { ...(input.config ?? {}), username: me },
      label: input.name ?? 'Vercel',
    };
  }

  // --- cli mode --------------------------------------------------------------

  /** The CLI's stored token; read-only. Missing = logged out → expired. */
  private async cliToken(): Promise<string> {
    for (const path of vercelAuthPaths(this.deps.cli)) {
      const raw = await this.deps.cli.readFile(path);
      if (raw === null) continue;
      try {
        const token = (JSON.parse(raw) as { token?: unknown }).token;
        if (typeof token === 'string' && token) return token;
      } catch {
        /* not json: keep looking */
      }
    }
    throw new CliAuthError('vercel CLI is not logged in (run `vercel login`)', true);
  }

  private async connectCli(input: Extract<ConnectInput, { method: 'cli' }>, targetId: string) {
    const username = await this.whoami(await this.cliToken());
    const wanted = input.account.trim();
    if (wanted && wanted !== 'cli' && wanted.toLowerCase() !== username.toLowerCase())
      throw new Error(`vercel CLI is logged in as ${username}, not ${wanted}`);
    const ref = makeCredentialRef('vercel', targetId, 'cli');
    await this.deps.vault.set(ref, JSON.stringify({ kind: 'cli', account: username }));
    return {
      credentialRef: ref,
      config: { ...(input.config ?? {}), username, account: username },
      label: input.name ?? 'Vercel',
    };
  }

  async cliStatus(): Promise<CliStatus> {
    const loginCommand = 'vercel login';
    const { binary, version } = await cliInstall(this.deps.cli, 'vercel', ['--version'], (out) =>
      semver(out),
    );
    if (!binary) return { installed: false, binary: null, version: null, loginCommand, accounts: [] };
    const token = await this.cliToken().catch(() => null);
    if (token === null) return { installed: true, binary, version, loginCommand, accounts: [] };
    const who = await this.deps.cli.run('vercel', ['whoami'], { timeoutMs: 15_000 });
    const username =
      who.exitCode === 0
        ? firstLine(
            who.stdout
              .trim()
              .split(/\r?\n/)
              .filter((l) => l && !/^>/.test(l))
              .at(-1) ?? '',
          )
        : '';
    return {
      installed: true,
      binary,
      version,
      loginCommand,
      accounts: username
        ? [{ id: username, label: username, active: true }]
        : [{ id: 'cli', label: 'vercel CLI login', active: false, detail: 'token present, whoami failed' }],
    };
  }

  cliLoginCommand(): CliCommand {
    return { bin: 'vercel', args: ['login'] };
  }

  async health(target: TargetInfo): Promise<HealthResult> {
    const entry = await readCliEntry(this.deps.vault, target).catch((e: Error) => {
      throw new CliAuthError(e.message, false);
    });
    if (!entry) return testToHealth(await this.test(target));
    try {
      return { ok: true, identity: await this.whoami(await this.cliToken()) };
    } catch (e) {
      return {
        ok: false,
        expired:
          e instanceof CliAuthError ? e.expired : /rejected the token \(40[13]\)/.test((e as Error).message),
        error: (e as Error).message,
      };
    }
  }

  private async whoami(token: string): Promise<string> {
    const r = await this.deps.fetch('https://api.vercel.com/v2/user', {
      headers: { Authorization: `Bearer ${token}` },
    });
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
    if (await readCliEntry(this.deps.vault, target)) return this.cliToken();
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
    const [cmd, sub] = commandHead(argv);
    if (isHelp(argv)) return ['read']; // before the bare-`vercel`-deploys rule
    if (cmd === 'curl') return curlScope(argv.slice(1));
    if (
      cmd === 'remove' ||
      cmd === 'rm' ||
      (cmd === 'env' && sub === 'rm') ||
      (cmd === 'domains' && sub === 'rm') ||
      (cmd === 'projects' && sub === 'rm') ||
      sub === 'rm' ||
      sub === 'remove'
    )
      return ['delete'];
    if (
      cmd === undefined ||
      cmd === 'deploy' ||
      cmd === 'promote' ||
      cmd === 'rollback' ||
      cmd === 'redeploy' ||
      cmd === 'alias' ||
      cmd === 'build'
    )
      return ['deploy'];
    if (cmd === 'env' && (sub === 'add' || sub === 'pull')) return sub === 'pull' ? ['read'] : ['write'];
    if (hasVerb(argv, /^(add|link|set)$/)) return ['write'];
    if (VERCEL_READ.has(cmd) || (sub !== undefined && VERCEL_READ_SUB.has(sub))) return ['read'];
    return ['write']; // unknown verbs fail closed
  }
}

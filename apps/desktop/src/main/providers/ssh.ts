import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPrivateDir } from '@styx/broker';
import { copy, fill } from '@styx/core';
import { execa } from 'execa';
import { makeCredentialRef } from '../services/credential-vault';
import { StyxSshAgent } from './ssh-agent';
import type {
  AdapterDeps,
  ConnectInput,
  GrantInfo,
  IssuedCredential,
  ProviderAdapter,
  Scope,
  TargetInfo,
  TestResult,
} from './types';
import { hasVerb } from './types';

/** The bit of node-pty a password sign-in needs: ssh reads the password from its terminal, never from env or a file. */
export interface SshTerminal {
  onData(cb: (data: string) => void): unknown;
  onExit(cb: (e: { exitCode: number }) => void): unknown;
  write(data: string): void;
  kill(): void;
}
export type SpawnTerminal = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<SshTerminal>;

/** node-pty, loaded on first use (as PtyService does) so tests without the native module still import this file. */
const spawnTerminal: SpawnTerminal = async (file, args, env) => {
  const pty = (await import('node-pty')) as unknown as {
    spawn: (f: string, a: string[], o: Record<string, unknown>) => SshTerminal;
  };
  return pty.spawn(file, args, { name: 'xterm', cols: 120, rows: 30, env });
};

export interface SshAdapterOptions {
  /** Where a grant's socket, ssh_config and control socket live: a private 0700 dir (Windows: under userData). */
  socketDir?: string;
  spawnTerminal?: SpawnTerminal;
  /** The system ssh Styx signs in with (default: the first of the usual absolute paths). */
  sshPath?: string;
  /** `ssh -O check` / `-O exit` against a master's control socket; returns the exit code. */
  controlSsh?: (args: string[]) => Promise<number>;
  onSign?: (grantId: string, info: { keyType: string; comment: string }) => void;
  platform?: NodeJS.Platform;
}

/**
 * `~` and `$HOME` in a key path. Users type `~/.ssh/id_ed25519` — the shell would expand it, `readFile` will not,
 * so every such connect died with ENOENT on a path that looks perfectly correct in the form.
 */
export const expandHome = (p: string): string => {
  const home = homedir();
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(home, p.slice(2));
  if (p.startsWith('$HOME/')) return join(home, p.slice(6));
  return p;
};

/** `Permission denied (password).`: the server offers no key sign-in, so no key Styx holds can ever work there. */
export const passwordOnly = (stderr: string): boolean => {
  const m = /Permission denied \(([^)]*)\)/.exec(stderr);
  return m !== null && !(m[1] ?? '').split(',').includes('publickey');
};

/** Plain host names, IPv4/IPv6 addresses and user names only: these lines are read by ssh as configuration. */
// Never a leading `-`: ssh would read the value as an option on its command line.
const SSH_HOST = /^[A-Za-z0-9_[][A-Za-z0-9._:[\]-]*$/;
const SSH_USER = /^[A-Za-z0-9_][A-Za-z0-9._@-]*$/;
/** One jump hop: `[user@]host[:port]`; several are comma-separated. */
const SSH_HOP = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*(?::\d{1,5})?$/;

/** A host an agent may be told about (`list_targets`) or ssh may be handed: the same rule the grant's config uses. */
export const sshHostOk = (host: string): boolean => SSH_HOST.test(host);

/** How an SSH target signs in (ADR-0031): a key file served by Styx, a password from the keychain, or the person's own ssh setup. */
export type SshAuth = 'key' | 'password' | 'agent';

interface SshSecret {
  auth: SshAuth;
  keyPath?: string;
  passphrase?: string;
  password?: string;
  /** Password targets: where the password may be typed (`user@host:port via jump`), fixed when it was saved. */
  address?: string;
  /** Password targets: the server's host keys, pinned on the first sign-in and required after it. */
  knownHosts?: string;
}

/** Where a target signs in, as one comparable string: a password is only ever typed to the address it was saved for. */
export const sshAddressOf = (c: Record<string, unknown>): string =>
  `${String(c['user'] ?? '')}@${String(c['host'] ?? '').toLowerCase()}:${String(c['port'] ?? 22)}` +
  (typeof c['proxyJump'] === 'string' && c['proxyJump'] !== '' ? ` via ${c['proxyJump']}` : '');

const escapeRe = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a prompt from the sign-in terminal is the target's own password prompt: `user@host's password:`, or the
 * keyboard-interactive `(user@host) Password:` / `Password for user@host:`, exactly, and nothing a jump host or a
 * banner could word to look like it. A bare `Password:` only when no jump host is in the way.
 */
export const isTargetPasswordPrompt = (line: string, user: string, host: string, jump: boolean): boolean => {
  // OpenSSH prints at most 30 characters of the user and 128 of the host in "user@host's password:".
  const who = `${escapeRe(user.slice(0, 30))}@${escapeRe(host.toLowerCase().slice(0, 128))}`;
  const exact = new RegExp(`^(?:\\(${who}\\) )?(?:${who}'s password|password(?: for ${who})?): ?$`, 'i');
  if (!exact.test(line)) return false;
  return jump
    ? line.toLowerCase().includes(`${user.slice(0, 30).toLowerCase()}@${host.toLowerCase().slice(0, 128)}`)
    : true;
};

/** ssh's output as a message: the password scrubbed should a server ever echo it, control characters out, short. */
const said = (out: string, password: string | null): string =>
  (password ? out.split(password).join('••••') : out)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1)
    ?.slice(0, 200) ?? '';

/** The system ssh by absolute path for Styx's own sign-in: never whichever `ssh` an agent put first on PATH. */
const SYSTEM_SSH = ['/usr/bin/ssh', '/bin/ssh', '/usr/local/bin/ssh', '/opt/homebrew/bin/ssh'];
const systemSsh = (): string => {
  const found = SYSTEM_SSH.find((p) => existsSync(p));
  if (found === undefined)
    throw new Error('OpenSSH was not found in /usr/bin, /bin, /usr/local/bin or /opt/homebrew/bin');
  return found;
};

/**
 * The ssh_config every `ssh`/`scp`/`sftp` of one grant reads (`-F`, ADR-0031), so a bare `ssh <host>` reaches the
 * target with its saved user, port and jump host instead of ssh's defaults (the local login name, port 22), and
 * signs in the way the target says: the grant's agent even when the person's own config names another one, ssh's
 * connection Styx signed in with the password (a control socket), or the person's own setup. Values the agent passes itself still win;
 * the person's own config follows for every other host. Fails closed on anything that is not a plain name: a
 * newline in a repo-authored target could otherwise add a `ProxyCommand`.
 */
export const sshConfigFor = (
  target: { host?: unknown; user?: unknown; port?: unknown; proxyJump?: unknown },
  sign: { auth: SshAuth; socketPath: string | null; controlPath?: string | null },
  platform: NodeJS.Platform,
  home: string,
): string => {
  const host = String(target.host ?? '');
  const user = String(target.user ?? '');
  const port = Number(target.port ?? 22);
  if (target.proxyJump !== undefined && typeof target.proxyJump !== 'string')
    throw new Error('SSH jump host must be text like user@host:port');
  const jump = target.proxyJump === undefined || target.proxyJump === '' ? null : target.proxyJump;
  if (!SSH_HOST.test(host))
    throw new Error(`SSH target host must be a bare host name or address, not "${host}"`);
  if (!SSH_USER.test(user)) throw new Error(`SSH target user must be a plain user name, not "${user}"`);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`SSH target port ${port} is invalid`);
  if (jump !== null && !jump.split(',').every((h) => SSH_HOP.test(h)))
    throw new Error(`SSH jump host must be user@host:port (comma-separated for several), not "${jump}"`);
  const posix = platform !== 'win32';
  const signIn =
    sign.auth === 'password' && sign.controlPath != null
      ? // Every command rides the connection Styx signed in itself; none can ask for the password on its own.
        [
          `  ControlPath "${sign.controlPath}"`,
          '  ControlMaster no',
          '  PasswordAuthentication no',
          '  KbdInteractiveAuthentication no',
          '  IdentityAgent none',
        ]
      : sign.auth === 'key' && sign.socketPath !== null
        ? [`  IdentityAgent "${sign.socketPath}"`]
        : [];
  return [
    '# Written by Styx for one grant; removed when the grant ends.',
    `Host ${host}`,
    `  User ${user}`,
    `  Port ${port}`,
    // An agent cannot answer "Are you sure you want to continue connecting?"; a changed key still fails.
    '  StrictHostKeyChecking accept-new',
    ...(jump !== null ? [`  ProxyJump ${jump}`] : []),
    ...signIn,
    'Match all',
    `  Include "${join(home, '.ssh', 'config')}"`,
    ...(posix ? ['  Include /etc/ssh/ssh_config'] : []),
    '',
  ].join('\n');
};

/** ssh's flags that take a value (`-p 22`, `-o X=y`): their values are never the destination or the command. */
const SSH_VALUE_FLAGS = new Set('BbcDEeFIiJLlmOoPpQRSWw'.split(''));

/** Where the destination sits in an ssh argv: the first word that is neither an option nor an option's value. */
export const sshDestinationIndex = (argv: string[]): number => {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--') return i + 1;
    if (!a.startsWith('-') || a === '-') return i;
    // `-p 22` takes the next word; `-p22` and grouped flags like `-tt` do not.
    if (a.length === 2 && SSH_VALUE_FLAGS.has(a.charAt(1))) i++;
  }
  return argv.length;
};

export class SshAdapter implements ProviderAdapter {
  readonly provider = 'ssh' as const;
  readonly authMethod = 'ssh' as const;
  readonly tools = ['ssh', 'scp', 'rsync', 'sftp'];
  private readonly agents = new Map<string, StyxSshAgent>();
  private readonly configs = new Map<string, string>();
  /** Password targets: the signed-in master connection per mint, and its control socket. */
  private readonly masters = new Map<
    string,
    { term: SshTerminal; controlPath: string; knownHosts: string }
  >();

  constructor(
    private readonly deps: AdapterDeps,
    private readonly opts: SshAdapterOptions = {},
  ) {}

  private get platform(): NodeJS.Platform {
    return this.opts.platform ?? process.platform;
  }

  async connect(input: ConnectInput, targetId: string) {
    if (input.method !== 'ssh') throw new Error('SSH connect expects host and user');
    const auth = input.auth ?? 'key';
    const config = {
      host: input.host,
      user: input.user,
      port: input.port ?? 22,
      auth,
      // Always written, empty for none: the saved config is merged over the old one, and a jump host the form did not
      // show (one from .styx/project.json) must not survive the person connecting without it.
      proxyJump: input.proxyJump ?? '',
    };
    // The same check every grant makes, so a bad host fails here rather than on the first command.
    sshConfigFor(config, { auth, socketPath: null }, this.platform, homedir());
    let secret: SshSecret;
    if (auth === 'key') {
      if (!input.keyPath) throw new Error('Choose the key file this server accepts');
      // Expand before both the readability check and the vault write, so what is stored is what will be read.
      const keyPath = expandHome(input.keyPath);
      await readFile(keyPath, 'utf8'); // key must be readable now; it is read again per grant, never copied
      secret = { auth, keyPath, ...(input.passphrase ? { passphrase: input.passphrase } : {}) };
    } else if (auth === 'password') {
      // Windows' OpenSSH cannot share one signed-in connection (no ControlMaster), and handing the password to the
      // agent's own ssh would hand it to the agent.
      if (this.platform === 'win32') throw new Error(copy.connect.ssh.passwordWindows);
      if (!input.password) throw new Error('Enter the password for this server');
      secret = { auth, password: input.password, address: sshAddressOf(config) };
    } else secret = { auth };
    const ref = makeCredentialRef('ssh', targetId, auth === 'key' ? 'ssh-key-path' : 'ssh-login');
    await this.deps.vault.set(ref, JSON.stringify(secret));
    return { credentialRef: ref, config, label: `SSH ${input.user}@${input.host}` };
  }

  private async secret(target: TargetInfo): Promise<SshSecret> {
    if (!target.credentialRef) throw new Error('not connected');
    const raw = await this.deps.vault.get(target.credentialRef);
    if (!raw) throw new Error('credential missing from keychain');
    const parsed = JSON.parse(raw) as Partial<SshSecret>;
    // Rows saved before ADR-0031 hold only a key path, and before paths were expanded, a literal `~`.
    const auth = parsed.auth ?? 'key';
    return auth === 'key'
      ? { ...parsed, auth, keyPath: expandHome(parsed.keyPath ?? '') }
      : { ...parsed, auth };
  }

  /** The private directory a grant's sockets, config and pinned host keys live in (0700, owned by us, not a symlink). */
  private dir(): string {
    if (this.platform === 'win32') return this.opts.socketDir ?? join(tmpdir(), 'styx-ssh');
    return this.opts.socketDir ?? join(tmpdir(), `styx-${process.getuid?.() ?? 0}`);
  }

  private async privateDir(): Promise<string> {
    const dir = this.dir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (this.platform !== 'win32') assertPrivateDir(dir);
    return dir;
  }

  /** Short names: a Unix socket path has a 104-byte limit on macOS, and the temp dir already takes half of it. */
  private socketPath(handle: string): string {
    if (this.platform === 'win32') return `\\\\.\\pipe\\styx-agent-${handle}`;
    return join(this.dir(), `a-${handle}.sock`);
  }

  /** Signs in exactly as an agent's command will: through the grant's own config (and, for a password, its master). */
  async test(target: TargetInfo): Promise<TestResult> {
    const probe: GrantInfo = { id: `test-${Date.now()}`, scope: ['read'], duration: 'once', expiresAt: null };
    try {
      const issued = await this.issue(probe, target);
      try {
        if (issued.kind !== 'ssh-agent') throw new Error('unexpected credential');
        const host = String(target.config['host']);
        const user = String(target.config['user']);
        const port = String(target.config['port'] ?? 22);
        // A command every server shell knows: sh, cmd.exe and PowerShell (`true` does not exist on Windows).
        const r = await execa(
          'ssh',
          ['-F', issued.configPath, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '--', host, 'exit 0'],
          { env: { ...process.env, ...issued.env }, reject: false, timeout: 20_000, stdin: 'ignore' },
        );
        if (r.exitCode === 0) return { ok: true, identity: `${user}@${host}` };
        const stderr = String(r.stderr ?? '').trim();
        return {
          ok: false,
          error: passwordOnly(stderr)
            ? fill(copy.connect.ssh.passwordOnly, { host, user, port })
            : stderr || `ssh exited ${r.exitCode}`,
        };
      } finally {
        await this.revoke(issued);
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /**
   * Password targets (ADR-0031): Styx signs in itself, once per mint, on an OpenSSH master connection whose terminal
   * only main can see, and types the password at ssh's own prompt. The agent's commands ride that connection through
   * the control socket and never meet the password. The sign-in reads no config files (an agent can edit
   * `~/.ssh/config`), runs the system ssh by absolute path, checks the host key Styx pinned, answers only the
   * target's exact password prompt, once, and counts as done when `ssh -O check` says so.
   */
  private async openMaster(
    handle: string,
    controlPath: string,
    target: { host: string; user: string; port: number; jump: string; credentialRef: string },
    secret: SshSecret,
  ): Promise<void> {
    const knownHosts = join(this.dir(), `k-${handle}`);
    await rm(controlPath, { force: true });
    await writeFile(knownHosts, secret.knownHosts ?? '', { mode: 0o600 });
    const base = ['-F', 'none', '-o', `ControlPath=${controlPath}`];
    const pinned = secret.knownHosts ? 'yes' : 'accept-new';
    const hops = target.jump === '' ? [] : target.jump.split(',');
    if (hops.length > 1) throw new Error(copy.connect.ssh.oneJump);
    const hop = /^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/.exec(hops[0] ?? '');
    const jumpCommand =
      hop === null
        ? 'none'
        : [
            `"${this.sshPath()}" -F none -o BatchMode=yes -o LogLevel=ERROR`,
            `-o StrictHostKeyChecking=${pinned} -o "UserKnownHostsFile=${knownHosts}" -o HashKnownHosts=no`,
            hop[1] ? `-l ${hop[1]}` : '',
            hop[3] ? `-p ${hop[3]}` : '',
            `-W [%h]:%p ${hop[2] ?? ''}`,
          ]
            .filter(Boolean)
            .join(' ');
    const term = await (this.opts.spawnTerminal ?? spawnTerminal)(
      this.sshPath(),
      [
        ...base,
        '-M',
        '-N',
        '-o',
        'ControlMaster=yes',
        '-o',
        'ControlPersist=no',
        '-o',
        'ClearAllForwardings=yes',
        '-o',
        `User=${target.user}`,
        '-o',
        `Port=${target.port}`,
        '-o',
        'ProxyJump=none',
        // The jump hop, if any, is Styx's own batch-mode ssh: it can neither prompt nor print a banner on this
        // terminal, its host key is pinned with the target's, and it signs in with a key or the person's agent.
        '-o',
        `ProxyCommand=${jumpCommand}`,
        '-o',
        `UserKnownHostsFile=${knownHosts}`,
        '-o',
        'HashKnownHosts=no',
        // First sign-in pins the key (the person is usually watching Test connection); every later one requires it.
        '-o',
        `StrictHostKeyChecking=${pinned}`,
        // No banners: a server or jump host must not be able to print something that reads like the prompt.
        '-o',
        'LogLevel=ERROR',
        '-o',
        'PasswordAuthentication=yes',
        '-o',
        'KbdInteractiveAuthentication=yes',
        '-o',
        'PubkeyAuthentication=no',
        '-o',
        'PreferredAuthentications=keyboard-interactive,password',
        '-o',
        'NumberOfPasswordPrompts=1',
        '-o',
        'ConnectTimeout=10',
        '--',
        target.host,
      ],
      // ssh must ask on its terminal: an askpass in main's own environment would take the prompt elsewhere.
      Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !k.startsWith('SSH_ASKPASS') && k !== 'DISPLAY'),
      ),
    );
    this.masters.set(handle, { term, controlPath, knownHosts });
    let password: string | null = secret.password ?? null;
    const scrub = secret.password ?? null;
    const jump = target.jump !== '';
    try {
      await new Promise<void>((resolve, reject) => {
        let out = '';
        let settled = false;
        let checking = false;
        const settle = (err?: Error) => {
          if (settled) return;
          settled = true;
          password = null;
          clearInterval(poll);
          clearTimeout(timer);
          if (err) reject(err);
          else resolve();
        };
        term.onData((data) => {
          out = (out + data).slice(-4000);
          const tail = out.replace(/\r/g, '').trimEnd().split('\n').at(-1) ?? '';
          if (!/[:?]$/.test(tail)) return;
          if (password !== null && isTargetPasswordPrompt(tail, target.user, target.host, jump)) {
            term.write(`${password}\r`);
            password = null;
            out = '';
          } else if (/password|passphrase|code|token|verif|factor|otp|pin\b|\(yes\/no/i.test(tail)) {
            settle(new Error(fill(copy.connect.ssh.unexpectedPrompt, { prompt: said(tail, scrub) })));
          }
        });
        term.onExit(() =>
          settle(
            new Error(
              /host key verification failed|remote host identification has changed/i.test(out)
                ? copy.connect.ssh.hostKeyChanged
                : said(out, scrub) || 'ssh closed before signing in',
            ),
          ),
        );
        const poll = setInterval(() => {
          if (checking || !existsSync(controlPath)) return;
          checking = true;
          void this.controlSsh([...base, '-O', 'check', '--', target.host]).then((code) => {
            checking = false;
            if (code === 0) settle();
          });
        }, 150);
        const timer = setTimeout(() => settle(new Error('timed out signing in')), 30_000);
      });
    } catch (e) {
      await this.closeMaster(handle);
      throw e;
    }
    // The first sign-in learnt the server's key: keep it with the password, so a later one cannot be intercepted.
    if (!secret.knownHosts) {
      const learnt = await readFile(knownHosts, 'utf8').catch(() => '');
      // Only onto the entry this sign-in used: a reconnect or a removal during the sign-in must not be undone.
      const raw = await this.deps.vault.get(target.credentialRef);
      const now = raw ? (JSON.parse(raw) as Partial<SshSecret>) : null;
      if (
        learnt.trim() !== '' &&
        now !== null &&
        now.password === secret.password &&
        now.address === secret.address &&
        !now.knownHosts
      )
        await this.deps.vault.set(target.credentialRef, JSON.stringify({ ...now, knownHosts: learnt }));
    }
  }

  private sshPath(): string {
    return this.opts.sshPath ?? systemSsh();
  }

  private controlSsh(args: string[]): Promise<number> {
    if (this.opts.controlSsh) return this.opts.controlSsh(args);
    return execa(this.sshPath(), args, { reject: false, timeout: 5_000 }).then((r) => r.exitCode ?? 1);
  }

  private async closeMaster(handle: string): Promise<void> {
    const m = this.masters.get(handle);
    this.masters.delete(handle);
    if (!m) return;
    // Ask the master to end first: killing the terminal alone would miss one the system ssh put in the background.
    await this.controlSsh(['-F', 'none', '-o', `ControlPath=${m.controlPath}`, '-O', 'exit', 'styx']).catch(
      () => undefined,
    );
    try {
      m.term.kill();
    } catch {
      /* already gone */
    }
    await rm(m.controlPath, { force: true });
    await rm(m.knownHosts, { force: true });
  }

  async issue(grant: GrantInfo, target: TargetInfo): Promise<IssuedCredential> {
    const secret = await this.secret(target);
    // The password goes only where it was saved for: a host, user, port or jump host changed since (an accepted
    // project.json, an edited database) needs the person to reconnect, never a sign-in somewhere new.
    if (secret.auth === 'password' && secret.address !== sshAddressOf(target.config))
      throw new Error(fill(copy.connect.ssh.addressChanged, { address: sshAddressOf(target.config) }));
    // One handle per mint, not per grant: a re-mint near expiry releases the old copy, and that must not take the
    // new socket, config or connection with it.
    const handle = randomBytes(6).toString('hex');
    const dir = await this.privateDir();
    const socketPath = secret.auth === 'key' ? this.socketPath(handle) : null;
    const controlPath = secret.auth === 'password' ? join(dir, `c-${handle}`) : null;
    // Validated before anything starts, so a bad host leaves no agent behind.
    const config = sshConfigFor(
      target.config,
      { auth: secret.auth, socketPath, controlPath },
      this.platform,
      homedir(),
    );
    const env: Record<string, string> = {};
    if (secret.auth === 'key' && socketPath !== null) {
      const pem = await readFile(secret.keyPath ?? '', 'utf8');
      const agent = new StyxSshAgent((info) => this.opts.onSign?.(grant.id, info));
      await agent.start(socketPath, pem, secret.passphrase);
      this.agents.set(handle, agent);
      env['SSH_AUTH_SOCK'] = socketPath;
    }
    const configPath = join(dir, `ssh-config-${handle}`);
    // A fresh file every time (`wx`): never one someone else created and could still write to.
    await rm(configPath, { force: true });
    await writeFile(configPath, config, { mode: 0o600, flag: 'wx' });
    this.configs.set(handle, configPath);
    if (controlPath !== null)
      await this.openMaster(
        handle,
        controlPath,
        {
          host: String(target.config['host']),
          user: String(target.config['user']),
          port: Number(target.config['port'] ?? 22),
          jump: typeof target.config['proxyJump'] === 'string' ? target.config['proxyJump'] : '',
          credentialRef: target.credentialRef ?? '',
        },
        secret,
      ).catch(async (e: unknown) => {
        await this.dropConfig(handle);
        throw e;
      });
    // git and rsync start ssh themselves; the shim adds `-F` for ssh, scp and sftp.
    env['GIT_SSH_COMMAND'] = `ssh -F "${configPath}" -o IdentitiesOnly=no`;
    env['RSYNC_RSH'] = `ssh -F "${configPath}"`;
    env['STYX_SSH_HOST'] = `${String(target.config['user'] ?? '')}@${String(target.config['host'])}`;
    return {
      kind: 'ssh-agent',
      socketPath,
      configPath,
      env,
      // A signed-in connection is not re-minted in a grant's last minute (each re-mint would sign in again and cut
      // the agent's running commands): the grant's own expiry timer ends it.
      expiresAt: controlPath !== null ? null : grant.expiresAt,
      scoped: true,
      handle,
    };
  }

  async revoke(issued: IssuedCredential): Promise<void> {
    if (issued.kind !== 'ssh-agent') return;
    const a = this.agents.get(issued.handle);
    if (a) {
      await a.stop();
      this.agents.delete(issued.handle);
    }
    await this.closeMaster(issued.handle);
    await this.dropConfig(issued.handle);
  }

  async revokeAll(): Promise<void> {
    for (const [id, a] of this.agents) {
      await a.stop();
      this.agents.delete(id);
    }
    for (const id of [...this.masters.keys()]) await this.closeMaster(id);
    for (const id of [...this.configs.keys()]) await this.dropConfig(id);
  }

  private async dropConfig(grantId: string): Promise<void> {
    const path = this.configs.get(grantId);
    this.configs.delete(grantId);
    if (path !== undefined) await rm(path, { force: true });
  }

  issuesScoped(): boolean {
    // The forwarded agent socket signs anything the remote host asks for; a "read" grant still opens a full login.
    return false;
  }

  scopeOfCommand(argv: string[], tool = 'ssh'): Scope[] {
    // scp/sftp/rsync move files in both directions: always a write; `rsync --delete` removes remote files.
    if (tool !== 'ssh') return hasVerb(argv, /^--delete(-[a-z]+)?$/) ? ['delete'] : ['write'];
    // ssh [-opts] destination [command…] — classify the remote command only.
    const remote = argv.slice(sshDestinationIndex(argv) + 1).join(' ');
    if (/\b(rm -rf|rm -r|rm -fr|dropdb|DROP |truncate|mkfs|shred)\b/i.test(remote)) return ['delete'];
    // Fail closed: shell metacharacters, command chains, pipes, redirects, or substitutions could hide anything
    // behind a benign-looking first word (`ls; rm …`), so they can never classify as read.
    if (/[;&|$`\n><]/.test(remote) || /\(|\{/.test(remote)) return ['write'];
    if (/\b(deploy|systemctl restart|docker compose up|pm2 (restart|reload))\b/.test(remote))
      return ['deploy'];
    // A bare `ssh host` is an interactive login: anything can happen in it.
    if (remote === '') return ['write'];
    if (/^(ls|cat|tail|head|df|uptime|true|hostname|whoami)\b/.test(remote)) return ['read'];
    return ['write'];
  }
}

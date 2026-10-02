import type { IPty } from 'node-pty';
import { execa } from 'execa';
import { EventEmitter } from 'node:events';
import { STRIPPED_ENV } from '../providers/cli-runner';
import { onePathKey } from './spawn-cli';

export interface PtySpawnOptions {
  id: string;
  cwd: string;
  shell?: string;
  args?: string[];
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export interface PtyEvents {
  data: [id: string, data: string];
  exit: [id: string, exitCode: number, signal: number | undefined];
}

/** The login shell's answer: its PATH and the absolute file each agent CLI name resolves to (`command -v`). */
export interface LoginEnv {
  path: string;
  which: Record<string, string>;
  resolvedAt: number;
}

/** Every agent CLI binary name DetectService knows, asked of the shell in the same call that reads PATH. */
export const SHELL_WHICH_NAMES: readonly string[] = ['claude', 'codex', 'gemini', 'agent', 'cursor-agent'];

const PATH_MARK = '__STYX_PATH__';
const POSIX_LOGIN_SCRIPT = `echo ${PATH_MARK}$PATH; for n in ${SHELL_WHICH_NAMES.join(' ')}; do command -v -- "$n" 2>/dev/null; done`;
const WIN_LOGIN_SCRIPT = [
  `'${PATH_MARK}' + [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')`,
  `foreach ($n in ${SHELL_WHICH_NAMES.map((n) => `'${n}'`).join(',')}) { $c = Get-Command $n -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c -and $c.Source) { $c.Source } }`,
].join('; ');

/**
 * Splits the login script's output: the `__STYX_PATH__` line is the PATH; every other line that is an absolute
 * path is a `command -v` hit, keyed by its base name (`claude.exe` → `claude`). Alias and function answers
 * (`claude: aliased to …`, a bare name) are not files and are dropped.
 */
export function parseLoginEnv(
  stdout: string,
  platform: NodeJS.Platform,
): { path: string; which: Record<string, string> } {
  let path = '';
  const which: Record<string, string> = {};
  const absolute = platform === 'win32' ? /^[A-Za-z]:[\\/]/ : /^\//;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith(PATH_MARK)) {
      path = line.slice(PATH_MARK.length).trim();
      continue;
    }
    if (!absolute.test(line)) continue;
    const base = (line.split(/[\\/]/).pop() ?? '').replace(/\.(exe|cmd|bat)$/i, '');
    if (base !== '' && !(base in which)) which[base] = line;
  }
  return { path, which };
}

/** Login PATH first, then whatever the process had that the shell did not list; no duplicates. */
export function mergePaths(primary: string, secondary: string, platform: NodeJS.Platform): string {
  const sep = platform === 'win32' ? ';' : ':';
  const out: string[] = [];
  const seen = new Set<string>();
  for (const dir of [...primary.split(sep), ...secondary.split(sep)]) {
    const key = platform === 'win32' ? dir.toLowerCase() : dir;
    if (dir === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out.join(sep);
}

interface PtyModule {
  spawn(
    file: string,
    args: string[],
    opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
  ): IPty;
}

/** Owns node-pty processes for sessions and the 130px terminal pane. Loaded lazily so tests without the native module still import cleanly. */
export class PtyService extends EventEmitter<PtyEvents> {
  private readonly ptys = new Map<string, IPty>();
  private mod: PtyModule | null = null;
  private loginEnv: LoginEnv | null = null;
  /** Styx's own tool folders (a private Node.js and what its npm installed), appended after the person's PATH. */
  private extraDirs: string[] = [];
  private loginInflight: Promise<LoginEnv> | null = null;

  constructor(readonly platform: NodeJS.Platform = process.platform) {
    super();
  }

  private async load(): Promise<PtyModule> {
    if (!this.mod) this.mod = (await import('node-pty')) as unknown as PtyModule;
    return this.mod;
  }

  /** GUI apps on macOS get a stripped PATH; the login shell's PATH, cached (see `resolveLoginEnv` for refreshing). */
  async resolveLoginPath(opts: { maxAgeMs?: number } = {}): Promise<string> {
    return (await this.resolveLoginEnv(opts)).path;
  }

  /**
   * What the user's terminal would see: the login shell's PATH and where it resolves each agent CLI name
   * (`command -v`, so aliases and version-manager shims count). One shell per call, cached; `maxAgeMs` lets a
   * re-detect (focus, spawn, a watcher event) ask again after an install edited the shell's rc file, while spawns
   * keep using the cached answer. Windows reads the machine + user `Path` from the environment store, since a
   * running process only ever sees the PATH it started with.
   */
  async resolveLoginEnv(opts: { maxAgeMs?: number } = {}): Promise<LoginEnv> {
    const cached = this.loginEnv;
    if (cached !== null && (opts.maxAgeMs === undefined || Date.now() - cached.resolvedAt <= opts.maxAgeMs))
      return cached;
    if (this.loginInflight !== null) return this.loginInflight;
    this.loginInflight = this.queryLoginEnv().finally(() => {
      this.loginInflight = null;
    });
    return this.loginInflight;
  }

  private async queryLoginEnv(): Promise<LoginEnv> {
    const processPath = process.env['PATH'] ?? '';
    const fallback: LoginEnv = { path: this.withExtra(processPath), which: {}, resolvedAt: Date.now() };
    try {
      const r =
        this.platform === 'win32'
          ? await execa('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_LOGIN_SCRIPT], {
              timeout: 5000,
              reject: false,
              windowsHide: true,
            })
          : await execa(this.defaultShell(), ['-ilc', POSIX_LOGIN_SCRIPT], {
              timeout: 5000,
              reject: false,
              env: { ...process.env, TERM: 'dumb' },
            });
      const parsed = parseLoginEnv(String(r.stdout ?? ''), this.platform);
      const path = parsed.path === '' ? processPath : mergePaths(parsed.path, processPath, this.platform);
      this.loginEnv = { path: this.withExtra(path), which: parsed.which, resolvedAt: Date.now() };
    } catch {
      this.loginEnv = fallback;
    }
    return this.loginEnv;
  }

  /**
   * Adds folders to the end of the PATH agents, terminals and detection see (Styx's private Node.js for Gemini).
   * Last, so the person's own tools always win; the cached login environment is refreshed to include them.
   */
  addPathDirs(dirs: readonly string[]): void {
    const fresh = dirs.filter((d) => !this.extraDirs.includes(d));
    if (fresh.length === 0) return;
    this.extraDirs = [...this.extraDirs, ...fresh];
    if (this.loginEnv !== null) this.loginEnv = { ...this.loginEnv, path: this.withExtra(this.loginEnv.path) };
  }

  private withExtra(path: string): string {
    const sep = this.platform === 'win32' ? ';' : ':';
    return this.extraDirs.length === 0 ? path : mergePaths(path, this.extraDirs.join(sep), this.platform);
  }

  defaultShell(): string {
    if (this.platform === 'win32')
      return process.env['STYX_WIN_SHELL'] === 'wsl' ? 'wsl.exe' : 'powershell.exe';
    return process.env['SHELL'] || '/bin/zsh';
  }

  async spawn(opts: PtySpawnOptions): Promise<{ pid: number }> {
    const { spawn } = await this.load();
    const shell = opts.shell ?? this.defaultShell();
    // Windows: PowerShell with a process-scoped Bypass, so `pnpm dev` (a .ps1 shim) runs as it would in a configured
    // terminal; WSL takes no arguments.
    const args =
      opts.args ??
      (this.platform === 'win32'
        ? /powershell(\.exe)?$|pwsh(\.exe)?$/i.test(shell)
          ? ['-NoLogo', '-ExecutionPolicy', 'Bypass']
          : []
        : ['-il']);
    const loginPath = await this.resolveLoginPath();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIPPED_ENV.has(k)) env[k] = v;
    Object.assign(
      env,
      { TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: env['LANG'] ?? 'en_US.UTF-8', PATH: loginPath },
      opts.env ?? {},
    );
    const p = spawn(shell, args, {
      name: 'xterm-256color',
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 30,
      cwd: opts.cwd,
      env: onePathKey(env, this.platform),
    });
    this.ptys.set(opts.id, p);
    p.onData((d) => this.emit('data', opts.id, d));
    p.onExit(({ exitCode, signal }) => {
      this.ptys.delete(opts.id);
      this.emit('exit', opts.id, exitCode, signal);
    });
    return { pid: p.pid };
  }

  write(id: string, data: string): void {
    this.ptys.get(id)?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.ptys.get(id)?.resize(cols, rows);
  }

  kill(id: string, signal?: string): void {
    const p = this.ptys.get(id);
    if (!p) return;
    p.kill(signal);
  }

  /** The pty child's pid (the process-group leader on posix), or null once it has exited. */
  pid(id: string): number | null {
    const p = this.ptys.get(id);
    return p ? p.pid : null;
  }

  /**
   * Kills everything behind a pty, not only the shell it started: `pnpm dev` → `next dev` → `next-server` all live in
   * the process group node-pty created, and signalling the shell alone left the server running and holding its port.
   * SIGTERM first (dev servers clean up on it), SIGKILL for anything still there three seconds later.
   */
  killGroup(id: string): void {
    const pid = this.pid(id);
    // No group to signal (already gone, a fake, or conpty, which tears its tree down itself): plain kill.
    if (pid === null || this.platform === 'win32') {
      this.kill(id);
      return;
    }
    const signalGroup = (signal: NodeJS.Signals): boolean => {
      try {
        process.kill(-pid, signal);
        return true;
      } catch {
        return false;
      }
    };
    if (!signalGroup('SIGTERM')) {
      this.kill(id);
      return;
    }
    const t = setTimeout(() => {
      if (this.ptys.has(id)) signalGroup('SIGKILL');
    }, 3000);
    t.unref?.();
  }

  has(id: string): boolean {
    return this.ptys.has(id);
  }

  killAll(): void {
    for (const id of [...this.ptys.keys()]) this.kill(id);
  }
}

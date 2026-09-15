import type { IPty } from 'node-pty';
import { execa } from 'execa';
import { EventEmitter } from 'node:events';
import { STRIPPED_ENV } from '../providers/cli-runner';

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

interface PtyModule {
  spawn(file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }): IPty;
}

/** Owns node-pty processes for sessions and the 130px terminal pane. Loaded lazily so tests without the native module still import cleanly. */
export class PtyService extends EventEmitter<PtyEvents> {
  private readonly ptys = new Map<string, IPty>();
  private mod: PtyModule | null = null;
  private loginPath: string | null = null;

  constructor(readonly platform: NodeJS.Platform = process.platform) {
    super();
  }

  private async load(): Promise<PtyModule> {
    if (!this.mod) this.mod = (await import('node-pty')) as unknown as PtyModule;
    return this.mod;
  }

  /** GUI apps on macOS get a stripped PATH; resolve the login shell's PATH once. */
  async resolveLoginPath(): Promise<string> {
    if (this.loginPath) return this.loginPath;
    if (this.platform === 'win32') return (this.loginPath = process.env['PATH'] ?? '');
    const shell = this.defaultShell();
    try {
      const r = await execa(shell, ['-ilc', 'echo __STYX_PATH__$PATH'], { timeout: 5000, reject: false, env: { ...process.env, TERM: 'dumb' } });
      const m = /__STYX_PATH__(.*)$/m.exec(String(r.stdout ?? ''));
      this.loginPath = m?.[1]?.trim() || (process.env['PATH'] ?? '');
    } catch {
      this.loginPath = process.env['PATH'] ?? '';
    }
    return this.loginPath;
  }

  defaultShell(): string {
    if (this.platform === 'win32') return process.env['STYX_WIN_SHELL'] === 'wsl' ? 'wsl.exe' : 'powershell.exe';
    return process.env['SHELL'] || '/bin/zsh';
  }

  async spawn(opts: PtySpawnOptions): Promise<{ pid: number }> {
    const { spawn } = await this.load();
    const shell = opts.shell ?? this.defaultShell();
    const args = opts.args ?? (this.platform === 'win32' ? [] : ['-il']);
    const loginPath = await this.resolveLoginPath();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIPPED_ENV.has(k)) env[k] = v;
    Object.assign(env, { TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: env['LANG'] ?? 'en_US.UTF-8', PATH: loginPath }, opts.env ?? {});
    const p = spawn(shell, args, { name: 'xterm-256color', cols: opts.cols ?? 120, rows: opts.rows ?? 30, cwd: opts.cwd, env });
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

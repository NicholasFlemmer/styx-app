import { ulid } from 'ulid';
import type { Repos } from '../db/repos';
import { fail } from '../ipc/bus';
import type { PtyService } from './pty-service';

export interface CommandSpawn {
  /** Absolute path (resolved on the login-shell PATH by the caller); never a shell string. */
  file: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

/** User terminals (the 130 px pane), one pty per `terminal.spawn`, cwd = the worktree. Ids are `term:<ulid>`. */
export class TerminalService {
  private readonly owners = new Map<string, string>();

  constructor(
    private readonly repos: Repos,
    private readonly pty: PtyService,
    private readonly env: () => Record<string, string>,
  ) {}

  async spawn(worktreeId: string): Promise<string> {
    const wt = this.repos.worktrees.get(worktreeId) ?? fail('not-found', `worktree ${worktreeId} not found`);
    const id = `term:${ulid()}`;
    await this.pty.spawn({ id, cwd: wt.path, env: this.env() });
    this.owners.set(id, worktreeId);
    return id;
  }

  /**
   * A single command in a pty the renderer can attach to (provider CLI logins: `gcloud auth login`, `aws sso login`,
   * `gh auth login --web`…). No shell in between, so argv is never re-parsed; the shim dir is not on its PATH.
   */
  async spawnCommand(cmd: CommandSpawn): Promise<string> {
    const id = `term:${ulid()}`;
    const win = this.pty.platform === 'win32';
    // conpty needs `cmd.exe /c` for `.cmd` shims (vercel.cmd, supabase.cmd); posix execs the file directly.
    const shell = win && /\.(cmd|bat)$/i.test(cmd.file) ? 'cmd.exe' : cmd.file;
    // cmd.exe re-parses its command line: refuse anything it treats as an operator (callers validate accounts too).
    if (shell === 'cmd.exe' && cmd.args.some((a) => /[&|<>^%!"()]/.test(a)))
      fail('invalid-input', 'argument not allowed on cmd.exe');
    const args = shell === 'cmd.exe' ? ['/c', cmd.file, ...cmd.args] : cmd.args;
    await this.pty.spawn({ id, cwd: cmd.cwd, shell, args, ...(cmd.env ? { env: cmd.env } : {}) });
    return id;
  }

  input(id: string, data: string): void {
    if (!this.pty.has(id)) fail('not-found', `terminal ${id} is not running`);
    this.pty.write(id, data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.pty.resize(id, cols, rows);
  }

  kill(id: string): void {
    this.pty.kill(id);
    this.owners.delete(id);
  }

  isTerminal(id: string): boolean {
    return id.startsWith('term:');
  }
}

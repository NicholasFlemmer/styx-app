import { ulid } from 'ulid';
import type { Repos } from '../db/repos';
import { fail } from '../ipc/bus';
import type { PtyService } from './pty-service';

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

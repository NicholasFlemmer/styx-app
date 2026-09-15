import type { DevRun, ProjectId } from '@styx/core';
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import { fail } from '../ipc/bus';
import type { Publisher } from '../store/publisher';
import type { ProjectService } from './project-service';
import type { PtyService } from './pty-service';
import type { TerminalService } from './terminal-service';

export interface RunServiceDeps {
  repos: Repos;
  publisher: Publisher;
  clock: Clock;
  terminals: TerminalService;
  pty: PtyService;
  projects: ProjectService;
  /** The login shell used to run the command string (`$SHELL -lc`); injectable for tests. */
  shell: () => string;
  platform: NodeJS.Platform;
}

export type RunSuggestion = { command: string; source: 'package.json' | 'makefile' | 'django' | 'cargo' | 'go' };

/**
 * "Run locally": one dev-server process per project, started in the main worktree, whose first localhost URL
 * feeds the design window. Implemented in WP3; the stubs keep the command surface registered.
 */
export class RunService {
  constructor(private readonly deps: RunServiceDeps) {}

  /** Rows for the snapshot. */
  all(): DevRun[] {
    return [];
  }

  async detect(_projectId: ProjectId): Promise<RunSuggestion[]> {
    return fail('internal', 'run.detect is not implemented yet');
  }

  async start(_projectId: ProjectId, _command: string): Promise<{ runId: string; terminalId: string }> {
    return fail('internal', 'run.start is not implemented yet');
  }

  stop(_projectId: ProjectId): void {
    fail('internal', 'run.stop is not implemented yet');
  }

  dismiss(_projectId: ProjectId): void {
    fail('internal', 'run.dismiss is not implemented yet');
  }

  /** Kills every run (app shutdown). */
  stopAll(): void {}

  protected get d(): RunServiceDeps {
    return this.deps;
  }
}

import type { Agent, CliInstall } from '@styx/core';
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import { fail } from '../ipc/bus';
import type { Publisher } from '../store/publisher';
import type { PtyService } from './pty-service';
import type { TerminalService } from './terminal-service';

export interface AgentServiceDeps {
  repos: Repos;
  publisher: Publisher;
  clock: Clock;
  terminals: TerminalService;
  pty: PtyService;
  /** Runs a CLI status command (`claude auth status --json` …); injectable so tests never spawn the real CLI. */
  exec: (bin: string, args: string[]) => Promise<{ stdout: string; exitCode: number }>;
  openExternal: (url: string) => Promise<void>;
  home: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Agent connections (Settings › App › Agents): verifies who each CLI is signed in as through the CLI's own
 * status command, runs its sign-in in a pty the renderer attaches to, and opens its install guide.
 * Implemented in WP1; the stubs keep the command surface registered.
 */
export class AgentService {
  constructor(private readonly deps: AgentServiceDeps) {}

  async verify(_agent: Agent): Promise<CliInstall> {
    return fail('internal', 'agent.verify is not implemented yet');
  }

  async login(_agent: Agent): Promise<{ terminalId: string; command: string }> {
    return fail('internal', 'agent.login is not implemented yet');
  }

  async installGuide(_agent: Agent): Promise<void> {
    return fail('internal', 'agent.installGuide is not implemented yet');
  }

  /** Keeps the container honest about unused deps until WP1 lands. */
  protected get d(): AgentServiceDeps {
    return this.deps;
  }
}

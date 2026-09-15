import {
  copy,
  deployCommandOf,
  fill,
  type Deploy,
  type DeployPhase,
  type Target,
  type TargetId,
} from '@styx/core';
import { ulid } from 'ulid';
import type { Repos } from '../db/repos';
import { fail } from '../ipc/bus';
import type { Publisher } from '../store/publisher';
import type { ProviderRegistry } from '../providers';
import type { CliRunner } from '../providers/cli-runner';
import { detectDeployCommands, type DeploySuggestion } from './deploy-detect';
import type { GrantService } from './grant-service';
import { logger } from './logger';
import type { PtyService } from './pty-service';
import type { TerminalService } from './terminal-service';

export interface DeployServiceDeps {
  repos: Repos;
  publisher: Publisher;
  providers: ProviderRegistry;
  grants: GrantService;
  terminals: TerminalService;
  pty: PtyService;
  cli: CliRunner;
  /** The login shell a user-written deploy command runs through (`$SHELL -lc`); injectable for tests. */
  shell?: () => string;
  platform?: NodeJS.Platform;
  /** Timestamps for the `model.deploys` rows; the wall clock unless a test injects one. */
  now?: () => number;
}

interface Running {
  deployId: string;
  terminalId: string;
  targetId: string;
  grantId: string | null;
  useId: string | null;
}

/**
 * Deploys a target by running the provider's own CLI, the same way an agent would have to.
 *
 * The point is that a deploy is not a privileged side door: it asks `GrantService` for a `deploy`-scoped grant
 * first, so a prod deploy hits the same MFA gate and the same audit trail as anything else that touches prod.
 * The credential the grant mints becomes the process environment, so the CLI never reads a token Styx did not
 * hand it, and the run is reported as a grant use with its exit code.
 */
export class DeployService {
  private readonly running = new Map<string, Running>();
  /** The latest row per target, so a fresh window's snapshot shows a deploy that is running or just finished. */
  private readonly latest = new Map<string, Deploy>();
  private readonly now: () => number;

  constructor(private readonly deps: DeployServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** Rows for the snapshot (`model.deploys`). */
  all(): Deploy[] {
    return [...this.latest.values()];
  }

  /**
   * Starts a deploy. Resolves once the process is spawned — progress lands in `model.deploys` (and, for now, as
   * `deploy.progress` events) and the output streams over the existing pty channel, so the renderer can attach a
   * terminal to it like any other.
   */
  async start(targetId: TargetId, triggeredBy: string): Promise<{ deployId: string; terminalId: string }> {
    const { repos, publisher } = this.deps;
    const target = repos.targets.get(targetId) ?? fail('not-found', 'target not found');
    const adapter = this.deps.providers.get(target.provider);
    // A built-in verb (Vercel) or the user's own command (`gcloud run deploy …` on a GCP target); neither → not deployable.
    const custom = adapter.deployCommand ? null : deployCommandOf(target);
    if (!adapter.deployCommand && custom === null)
      fail('invalid-input', fill(copy.deploy.notDeployable, { provider: copy.providers[target.provider] }));
    if (target.credentialRef === null) fail('invalid-input', copy.deploy.notConnected);

    const deployId = `dep:${ulid()}`;
    let row: Deploy = {
      deployId,
      targetId,
      projectId: target.projectId,
      phase: 'requesting-grant',
      terminalId: null,
      exitCode: null,
      error: null,
      startedAt: this.now(),
      endedAt: null,
    };
    const emit = (
      phase: DeployPhase,
      extra: { exitCode?: number | null; error?: string | null; terminalId?: string } = {},
    ) => {
      const done = phase === 'succeeded' || phase === 'failed' || phase === 'cancelled';
      row = {
        ...row,
        phase,
        exitCode: extra.exitCode ?? null,
        error: extra.error ?? null,
        // The terminal id sticks once known: the modal attaches to it whichever phase it opens on.
        terminalId: extra.terminalId ?? row.terminalId,
        endedAt: done ? this.now() : null,
      };
      this.latest.set(targetId, row);
      publisher.deploysSet(row);
      publisher.sendEvent('deploy.progress', {
        deployId,
        targetId,
        phase,
        exitCode: extra.exitCode ?? null,
        error: extra.error ?? null,
        terminalId: extra.terminalId ?? null,
      });
    };

    emit('requesting-grant');
    // Prod + deploy scope means this goes through MFA and the ask, exactly as an agent's request would.
    const outcome = await this.deps.grants
      .request({
        sessionId: null,
        targetId: target.id,
        scope: ['deploy'],
        reason: copy.deploy.reason,
        triggeredBy,
      })
      .catch((e: Error) => {
        emit('failed', { error: e.message });
        throw e;
      });
    if (outcome.kind === 'denied') {
      emit('failed', { error: copy.deploy.denied });
      fail('forbidden', copy.deploy.denied);
    }
    if (outcome.kind !== 'active') {
      // The user was asked and has not answered yet: the ask owns the flow from here.
      emit('failed', { error: copy.deploy.needsApproval });
      fail('invalid-transition', copy.deploy.needsApproval);
    }

    const grant = outcome.grant;
    const cred = await this.deps.grants.credentialFor(grant.id).catch((e: Error) => {
      emit('failed', { error: e.message });
      throw e;
    });

    const project = repos.projects.get(target.projectId);
    const cwd = project?.path ?? fail('not-found', 'project path missing');

    let spawn: { file: string; args: string[]; env: Record<string, string>; label: string };
    if (adapter.deployCommand) {
      const cmd = adapter.deployCommand(this.info(target));
      const file = await this.deps.cli.which(cmd.bin);
      if (!file) {
        emit('failed', { error: fill(copy.deploy.cliMissing, { bin: cmd.bin }) });
        fail('cli-missing', fill(copy.deploy.cliMissing, { bin: cmd.bin }));
      }
      spawn = { file, args: cmd.args, env: cmd.env ?? {}, label: `${cmd.bin} ${cmd.args.join(' ')}` };
    } else {
      // The user's command string goes through their login shell so it resolves exactly as in their terminal.
      const shell = this.deps.shell?.() ?? '/bin/sh';
      const text = custom ?? '';
      const args =
        this.deps.platform === 'win32'
          ? /wsl(\.exe)?$/i.test(shell)
            ? ['-e', 'sh', '-lc', text]
            : ['-NoLogo', '-Command', text]
          : ['-lc', text];
      spawn = { file: shell, args, env: {}, label: text };
    }

    const terminalId = await this.deps.terminals
      .spawnCommand({ file: spawn.file, args: spawn.args, cwd, env: { ...spawn.env, ...cred.env } })
      .catch((e: Error) => {
        emit('failed', { error: e.message });
        return fail('internal', `could not start ${spawn.label}: ${e.message}`);
      });

    const { useId } = this.deps.grants.use(grant.id, {
      command: spawn.label,
      scopeUsed: 'deploy',
      via: 'app',
      sessionId: null,
    });
    this.running.set(deployId, { deployId, terminalId, targetId, grantId: grant.id, useId });

    const onExit = (id: string, exitCode: number) => {
      if (id !== terminalId) return;
      this.deps.pty.off('exit', onExit);
      this.running.delete(deployId);
      this.deps.grants.endUse(useId, exitCode);
      emit(exitCode === 0 ? 'succeeded' : 'failed', { exitCode, terminalId });
      logger.info('deploy: finished', { deployId, target: target.name, exitCode });
    };
    this.deps.pty.on('exit', onExit);

    logger.info('deploy: started', { deployId, target: target.name, command: spawn.label });
    emit('running', { terminalId });
    return { deployId, terminalId };
  }

  /** Suggested deploy commands for a target (repo markers, and Cloud Run's service list for GCP). */
  async detect(targetId: TargetId): Promise<DeploySuggestion[]> {
    const target = this.deps.repos.targets.get(targetId) ?? fail('not-found', 'target not found');
    const project = this.deps.repos.projects.get(target.projectId) ?? fail('not-found', 'project not found');
    return detectDeployCommands(target, project.path, { cli: this.deps.cli });
  }

  /** Kills the deploy's process; the exit handler reports it as failed with the signal's exit code. */
  cancel(deployId: string): void {
    const run = this.running.get(deployId);
    if (run === undefined) return;
    this.deps.pty.kill(run.terminalId);
  }

  private info(target: Target) {
    return {
      id: target.id,
      provider: target.provider,
      name: target.name,
      env: target.env,
      config: target.config,
      credentialRef: target.credentialRef,
    };
  }
}

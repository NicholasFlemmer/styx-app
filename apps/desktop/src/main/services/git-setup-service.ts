import { copy, GIT_DOWNLOAD_URL, gitInstallRecipes, type InstallRecipe } from '@styx/core';
import type { Publisher } from '../store/publisher';
import type { ActivityService } from './activity-service';
import { findOnPath } from './detect-service';
import type { GitService } from './git';
import { logger } from './logger';
import type { PtyService } from './pty-service';
import type { TerminalService } from './terminal-service';

export interface GitSetupServiceDeps {
  git: Pick<GitService, 'available'>;
  terminals: Pick<TerminalService, 'spawnCommand'>;
  pty: Pick<PtyService, 'on' | 'off'>;
  publisher: Pick<Publisher, 'sendEvent'>;
  activity: Pick<ActivityService, 'append'>;
  openExternal: (url: string) => Promise<void>;
  loginPath: () => Promise<string>;
  shell: () => string;
  platform: NodeJS.Platform;
  home: string;
}

/**
 * Git is not a requirement to start (owner request, after an onboarding on a machine without it): a project works
 * as a plain folder. This is the one-click way to get it when it is wanted: the OS's own installer, a constant
 * chosen by platform (nothing from the renderer is run), in a terminal like an agent install. The git runner looks
 * git up on the login PATH again when it is not found, so the new git is used without restarting Styx.
 */
export class GitSetupService {
  constructor(private readonly deps: GitSetupServiceDeps) {}

  async status(): Promise<{ installed: boolean; version: string | null; installCommand: string | null }> {
    const [git, recipe] = await Promise.all([this.deps.git.available(), this.pickRecipe()]);
    return { ...git, installCommand: recipe?.command ?? null };
  }

  async install(download = false): Promise<{ terminalId: string | null; command: string | null }> {
    const recipe = download ? null : await this.pickRecipe();
    if (recipe === null) {
      await this.deps.openExternal(GIT_DOWNLOAD_URL);
      return { terminalId: null, command: null };
    }
    const spawn =
      recipe.shell === 'powershell'
        ? {
            file: findOnPath('powershell', await this.deps.loginPath(), 'win32') ?? 'powershell.exe',
            args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', recipe.command],
          }
        : { file: this.deps.shell(), args: ['-ilc', recipe.command] };
    const terminalId = await this.deps.terminals.spawnCommand({ ...spawn, cwd: this.deps.home });
    const { publisher, pty } = this.deps;
    const onExit = (id: string, exitCode: number) => {
      if (id !== terminalId) return;
      pty.off('exit', onExit);
      if (exitCode === 0)
        this.deps.activity.append({
          who: 'you',
          what: `${copy.gitSetup.name} · installed (${recipe.command})`,
          projectId: null,
          sessionId: null,
        });
      publisher.sendEvent('git.install', { terminalId, status: 'exited', exitCode });
    };
    pty.on('exit', onExit);
    logger.info('git: install started', { command: recipe.command, terminalId });
    publisher.sendEvent('git.install', { terminalId, status: 'running' });
    return { terminalId, command: recipe.command };
  }

  /** The first recipe for this platform whose required tool the login shell has; null when none applies. */
  private async pickRecipe(): Promise<InstallRecipe | null> {
    const recipes = gitInstallRecipes(this.deps.platform);
    if (recipes.length === 0) return null;
    const path = await this.deps.loginPath();
    return (
      recipes.find((r) => r.requires === null || findOnPath(r.requires, path, this.deps.platform) !== null) ??
      null
    );
  }
}

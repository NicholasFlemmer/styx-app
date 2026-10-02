import type { Container } from '../../container';
import type { CommandBus } from '../bus';

/** git.* — whether git is here, and the one-click install (owner request: git is never a requirement to start). */
export function registerGitCommands(bus: CommandBus, app: Container): void {
  bus.register('git.status', () => app.gitSetup.status());
  bus.register('git.install', ({ download }) => app.gitSetup.install(download));
}

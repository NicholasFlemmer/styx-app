import type { Container } from '../../container';
import type { CommandBus } from '../bus';
import { registerAuditCommands } from './audit';
import { registerGrantCommands } from './grant';
import { registerProjectCommands } from './project';
import { registerSessionCommands } from './session';
import { registerStoreCommands } from './store';
import { registerTargetCommands } from './target';
import { registerWindowCommands } from './window';
import { registerWorktreeCommands } from './worktree';

/** One registrar per domain; the contract test asserts every `COMMAND_NAMES` entry ends up registered. */
export function registerAllCommands(bus: CommandBus, app: Container): void {
  registerStoreCommands(bus, app);
  registerProjectCommands(bus, app);
  registerSessionCommands(bus, app);
  registerGrantCommands(bus, app);
  registerTargetCommands(bus, app);
  registerWorktreeCommands(bus, app);
  registerAuditCommands(bus, app);
  registerWindowCommands(bus, app);
}

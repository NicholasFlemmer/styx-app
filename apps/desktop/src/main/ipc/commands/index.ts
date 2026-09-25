import type { Container } from '../../container';
import type { CommandBus } from '../bus';
import { registerAccountCommands } from './account';
import { registerUpdateCommands } from './update';
import { registerAgentCommands } from './agent';
import { registerAuditCommands } from './audit';
import { registerDialogCommands } from './dialog';
import { registerGrantCommands } from './grant';
import { registerIdeCommands } from './ide';
import { registerProjectCommands } from './project';
import { registerCheckpointCommands } from './checkpoint';
import { registerDeployCommands } from './deploy';
import { registerDeviceCommands } from './device';
import { registerUsageCommands } from './usage';
import { registerSkillsCommands } from './skills';
import { registerPreviewCommands } from './preview';
import { registerRunCommands } from './run';
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
  registerPreviewCommands(bus, app);
  registerDeployCommands(bus, app);
  registerCheckpointCommands(bus, app);
  registerUsageCommands(bus, app);
  registerSkillsCommands(bus, app);
  registerAgentCommands(bus, app);
  registerAccountCommands(bus, app);
  registerUpdateCommands(bus, app);
  registerRunCommands(bus, app);
  registerDeviceCommands(bus, app);
  registerGrantCommands(bus, app);
  registerTargetCommands(bus, app);
  registerWorktreeCommands(bus, app);
  registerAuditCommands(bus, app);
  registerIdeCommands(bus, app);
  registerWindowCommands(bus, app);
  registerDialogCommands(bus, app);
}

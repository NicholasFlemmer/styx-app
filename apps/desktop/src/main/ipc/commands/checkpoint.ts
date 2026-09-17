import type { Container } from '../../container';
import { type CommandBus, fail } from '../bus';

/** Turn checkpoints (ADR-0020): the turn's diff and restoring the workspace to before it. Filled by CheckpointService. */
export function registerCheckpointCommands(bus: CommandBus, app: Container): void {
  bus.register('checkpoint.diff', async ({ checkpointId }) => {
    const svc = app.checkpoints;
    if (!svc) fail('internal', 'checkpoints unavailable');
    return svc.diff(checkpointId);
  });
  bus.register('checkpoint.revert', async ({ checkpointId }) => {
    const svc = app.checkpoints;
    if (!svc) fail('internal', 'checkpoints unavailable');
    await svc.revert(checkpointId);
    return {};
  });
}

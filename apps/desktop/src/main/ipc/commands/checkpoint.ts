import type { Container } from '../../container';
import type { CommandBus } from '../bus';

/** Turn checkpoints (ADR-0020): the turn's diff and restoring the workspace to before it (CheckpointService). */
export function registerCheckpointCommands(bus: CommandBus, app: Container): void {
  bus.register('checkpoint.diff', ({ checkpointId }) => app.checkpoints.diff(checkpointId));
  bus.register('checkpoint.revert', async ({ checkpointId }) => {
    await app.checkpoints.revert(checkpointId);
    return {};
  });
}

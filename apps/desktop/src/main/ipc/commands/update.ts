import type { Container } from '../../container';
import type { CommandBus } from '../bus';

/** update.* — updates in place (#119): ask the feed now; install the downloaded build and reopen. */
export function registerUpdateCommands(bus: CommandBus, app: Container): void {
  bus.register('update.check', async () => {
    await app.updates.check();
    return {};
  });
  bus.register('update.install', () => {
    app.updates.install();
    return {};
  });
}

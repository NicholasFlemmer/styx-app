import type { Container } from '../../container';
import type { CommandBus } from '../bus';

/** Usage page: re-read every CLI's rate limits on demand (Codex through its app-server; Claude reports mid-session). */
export function registerUsageCommands(bus: CommandBus, app: Container): void {
  bus.register('usage.refreshLimits', async () => {
    await app.usage.refreshLimits();
    return {};
  });
}

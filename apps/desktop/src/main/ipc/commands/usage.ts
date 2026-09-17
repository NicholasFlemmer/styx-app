import type { Container } from '../../container';
import type { CommandBus } from '../bus';

/** Usage page: re-read every CLI's rate limits. Filled by UsageService. */
export function registerUsageCommands(bus: CommandBus, app: Container): void {
  bus.register('usage.refreshLimits', async () => {
    await app.usage?.refreshLimits();
    return {};
  });
}

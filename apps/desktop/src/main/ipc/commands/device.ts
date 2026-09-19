import type { CommandBus } from '../bus';
import type { Container } from '../../container';

/** device.* — the simulator / emulator the design window mirrors (owner request). */
export function registerDeviceCommands(bus: CommandBus, app: Container): void {
  bus.register('device.tooling', () => app.devices.tooling());
  bus.register('device.list', async ({ platform }) => ({ devices: await app.devices.list(platform) }));
  bus.register('device.boot', ({ projectId, platform, device }) =>
    app.devices.boot(projectId, platform, device ?? null),
  );
  bus.register('device.stop', async ({ projectId, shutdown }) => {
    await app.devices.stop(projectId, shutdown);
    return {};
  });
  bus.register('device.mirror', ({ projectId }) => app.devices.mirror(projectId));
  bus.register('device.input', async ({ projectId, event }) => {
    await app.devices.input(projectId, event);
    return {};
  });
  bus.register('device.focus', async ({ projectId }) => {
    await app.devices.focus(projectId);
    return {};
  });
  bus.register('device.openScreenAccess', async () => {
    await app.devices.openScreenAccess();
    return {};
  });
}

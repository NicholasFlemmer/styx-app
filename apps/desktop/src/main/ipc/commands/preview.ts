import type { CommandBus } from '../bus';
import type { Container } from '../../container';

/** Design-window commands. The renderer owns where and whether; main owns the native view. */
export function registerPreviewCommands(bus: CommandBus, app: Container): void {
  bus.register('preview.set', ({ projectId, visible, bounds, url, device }) => {
    app.preview.set({ projectId, visible, bounds, url, device });
    return {};
  });

  bus.register('preview.reload', () => {
    app.preview.reload();
    return {};
  });

  bus.register('preview.openExternal', async ({ url }) => {
    await app.preview.openExternal(url);
    return {};
  });
}

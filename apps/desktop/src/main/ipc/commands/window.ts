import type { Container } from '../../container';
import type { CommandBus } from '../bus';

/** window.* */
export function registerWindowCommands(bus: CommandBus, app: Container): void {
  const { windows, publisher } = app;

  bus.register('window.popout', ({ sessionId }) => {
    windows.openPopout(sessionId);
    publisher.popoutsSet();
    return {};
  });

  bus.register('window.dock', ({ sessionId }) => {
    windows.dockPopout(sessionId);
    publisher.popoutsSet();
    return {};
  });

  bus.register('window.control', ({ window, sessionId, action }, ctx) => {
    windows.control(ctx.senderId, { window, ...(sessionId !== undefined ? { sessionId } : {}) }, action);
    return {};
  });
}

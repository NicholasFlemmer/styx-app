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

  bus.register('window.agentDock', ({ open }) => {
    if (open) windows.openDock();
    else windows.closeDock();
    return {};
  });

  /** A dock card routes here: bring the main window forward and select that session. */
  bus.register('window.focusSession', ({ sessionId }) => {
    windows.focusMain();
    publisher.sendEvent('session.focus', { sessionId });
    return {};
  });

  bus.register('window.control', ({ window, sessionId, action }, ctx) => {
    windows.control(ctx.senderId, { window, ...(sessionId !== undefined ? { sessionId } : {}) }, action);
    return {};
  });
}

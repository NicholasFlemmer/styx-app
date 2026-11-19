import type { Container } from '../../container';
import type { CommandBus } from '../bus';

/**
 * Connected apps (ADR-0033 tier 2). Only the person adds, signs in to or removes an app; agents have no command for
 * any of it and reach an app only through the broker's `use_app`, which asks before a change.
 */
export function registerConnectedAppsCommands(bus: CommandBus, app: Container): void {
  bus.register('connectedApps.add', async ({ name, url, projectId }) => ({
    appId: await app.connectedApps.add(name, url, projectId),
  }));
  bus.register('connectedApps.addMetaAds', async ({ token, adAccount, projectId }) => ({
    appId: await app.connectedApps.addMetaAds(token, adAccount, projectId),
  }));
  bus.register('connectedApps.signIn', ({ appId }) => {
    if (!app.connectedApps.current().some((a) => a.id === appId))
      throw new Error('That app is not connected.');
    // The browser sign-in can take minutes; the list shows its progress and any error.
    void app.connectedApps.signIn(appId).catch(() => undefined);
    return {};
  });
  bus.register('connectedApps.setProjects', ({ appId, projectIds }) => {
    app.connectedApps.setProjects(appId, projectIds);
    return {};
  });
  bus.register('connectedApps.remove', async ({ appId }) => {
    await app.connectedApps.remove(appId);
    return {};
  });
}

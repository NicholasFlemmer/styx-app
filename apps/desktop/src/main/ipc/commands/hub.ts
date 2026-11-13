import type { Container } from '../../container';
import type { CommandBus } from '../bus';

/**
 * Team hub commands (ADR-0032). `signIn` returns once the code is on screen; the polling runs on in main and
 * publishes each state change. Linking and sharing are the person's choices: agents have no command for either.
 */
export function registerHubCommands(bus: CommandBus, app: Container): void {
  bus.register('hub.signIn', async () => {
    await app.hub.signIn();
    return {};
  });
  bus.register('hub.cancelSignIn', () => {
    app.hub.cancelSignIn();
    return {};
  });
  bus.register('hub.openVerification', () => {
    app.hub.openVerification();
    return {};
  });
  bus.register('hub.openWeb', () => {
    const url = app.hub.current().webUrl;
    if (url !== '') void app.openExternal(url);
    return {};
  });
  bus.register('hub.signOut', async () => {
    await app.hub.signOut();
    return {};
  });
  bus.register('hub.refresh', async () => {
    await app.hub.refresh();
    return {};
  });
  bus.register('hub.linkProject', async ({ projectId, spaceId }) => {
    await app.hub.linkProject(projectId, spaceId);
    return {};
  });
  bus.register('hub.pickShare', async ({ sessionId, mode }) => ({
    pick: await app.hub.pickShare(sessionId, mode),
  }));
  bus.register('hub.share', async (input) => app.hub.share(input));
  bus.register('hub.createSpace', async ({ name }) => ({ spaceId: await app.hub.createSpace(name) }));
  bus.register('hub.shareLane', async ({ sessionId, shared }) => {
    await app.hub.shareLane(sessionId, shared);
    return {};
  });
}

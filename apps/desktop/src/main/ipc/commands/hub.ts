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
  bus.register('hub.rooms', async ({ projectId }) => ({ rooms: await app.hub.listRooms(projectId) }));
  bus.register('hub.teamRooms', async () => ({ rooms: await app.hub.teamRooms() }));
  bus.register('hub.shareConversation', async (input) => app.hub.shareConversation(input));
  bus.register('hub.conversationLinks', async ({ sessionId }) => ({
    links: await app.hub.conversationLinks(sessionId),
  }));
  bus.register('hub.turnOffLink', async ({ linkId }) => {
    await app.hub.turnOffLink(linkId);
    return {};
  });
  bus.register('hub.teamContext', async ({ q, stale }) => ({
    items: await app.hub.teamContext(q ?? null, stale === true),
  }));
  bus.register('hub.addContext', async (input) => ({ id: await app.hub.addContext(input) }));
  bus.register('hub.updateContext', async (input) => {
    await app.hub.updateContext({
      id: input.id,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.stale === undefined ? {} : { stale: input.stale }),
    });
    return {};
  });
  bus.register('hub.teamMembers', async () => app.hub.teamMembers());
  bus.register('hub.invite', async ({ email, name }) => ({ link: await app.hub.invite(email, name ?? null) }));
  bus.register('hub.removeMember', async ({ userId }) => {
    await app.hub.removeMember(userId);
    return {};
  });
  bus.register('hub.setRoomState', async ({ roomId, state }) => {
    await app.hub.setRoomState(roomId, state);
    return {};
  });
  bus.register('hub.joinRoom', async ({ sessionId, roomId, brings, mode }) => {
    await app.hub.joinRoom(sessionId, roomId, brings, mode);
    return {};
  });
  bus.register('hub.setRoomMode', async ({ sessionId, mode }) => {
    await app.hub.setRoomMode(sessionId, mode);
    return {};
  });
  bus.register('hub.leaveRoom', async ({ sessionId }) => {
    await app.hub.leaveRoom(sessionId);
    return {};
  });
  bus.register('hub.inbox', async () => ({ entries: await app.hub.inbox() }));
  bus.register('hub.thread', async ({ threadId }) => app.hub.thread(threadId));
  bus.register('hub.answer', async ({ askId, choice, text }) => {
    await app.hub.answer(askId, choice, text);
    return {};
  });
  bus.register('hub.reply', async ({ threadId, body }) => {
    await app.hub.reply(threadId, body);
    return {};
  });
  bus.register('hub.setTask', async ({ taskId, done }) => {
    await app.hub.setTask(taskId, done);
    return {};
  });
  bus.register('hub.setThreadStatus', async ({ threadId, status }) => {
    await app.hub.setThreadStatus(threadId, status);
    return {};
  });
  bus.register('hub.markRead', async ({ ids }) => {
    await app.hub.markRead(ids);
    return {};
  });
  bus.register('hub.createSpace', async ({ name }) => ({ spaceId: await app.hub.createSpace(name) }));
  bus.register('hub.shareLane', async ({ sessionId, shared }) => {
    await app.hub.shareLane(sessionId, shared);
    return {};
  });
}

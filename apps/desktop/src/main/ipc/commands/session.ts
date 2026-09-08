import type { Container } from '../../container';
import { type CommandBus, fail } from '../bus';

/** session.* · ask.respond · terminal.* */
export function registerSessionCommands(bus: CommandBus, app: Container): void {
  const { sessions, repos, terminals } = app;

  bus.register('session.spawn', async (input) => {
    const { session, worktree } = await sessions.spawn(input);
    return { sessionId: session.id, worktreeId: worktree.id };
  });

  bus.register('session.sendMessage', async ({ sessionId, body, attachments }) => {
    await sessions.sendMessage(sessionId, body, attachments);
    return {};
  });

  bus.register('session.ptyInput', ({ sessionId, data }) => {
    sessions.ptyInput(sessionId, data);
    return {};
  });

  bus.register('session.ptyResize', ({ sessionId, cols, rows }) => {
    sessions.ptyResize(sessionId, cols, rows);
    return {};
  });

  bus.register('session.configure', ({ sessionId, ...changes }) => {
    sessions.configure(sessionId, changes);
    return {};
  });

  bus.register('session.interrupt', ({ sessionId }) => {
    sessions.interrupt(sessionId);
    return {};
  });

  bus.register('session.stop', ({ sessionId }) => {
    app.broker.notifyStopping(sessionId);
    sessions.stop(sessionId);
    return {};
  });

  bus.register('session.archive', ({ sessionId }) => {
    sessions.archive(sessionId);
    return {};
  });

  bus.register('session.close', ({ sessionId }) => {
    sessions.close(sessionId);
    return {};
  });

  bus.register('session.resume', async ({ sessionId }) => {
    await sessions.resume(sessionId);
    return {};
  });

  bus.register('ask.respond', async ({ askId, resolution }) => {
    const ask = repos.pendingAsks.get(askId) ?? fail('not-found', `ask ${askId} not found`);
    // A repeat answer (double click, two windows) is a no-op; only a cancelled ask is really gone.
    if (ask.state === 'resolved') return {};
    if (ask.state !== 'open') fail('invalid-transition', 'ask is not open');
    if (ask.kind !== resolution.kind)
      fail('invalid-input', `ask is a ${ask.kind}, resolution is a ${resolution.kind}`);
    if (resolution.kind === 'grant') {
      const grantId = ask.grantId ?? fail('internal', 'grant ask without grant');
      if (resolution.outcome === 'granted') {
        const grant = repos.grants.get(grantId) ?? fail('not-found', 'grant not found');
        await app.grants.approve(grantId, grant.duration);
      } else app.grants.deny(grantId);
      return {};
    }
    const resolved = sessions.resolveAsk(ask.id, resolution);
    if (resolution.kind === 'decision') {
      const msg = repos.transcripts
        .last(ask.sessionId, 200)
        .find((m) => m.askId === ask.id && m.payload.kind === 'decision');
      if (msg && msg.payload.kind === 'decision') {
        repos.transcripts.upsert({ ...msg, payload: { ...msg.payload, chosen: resolution.chosen } });
        app.publisher.emit({
          op: 'transcript.replace',
          sessionId: ask.sessionId,
          messages: repos.transcripts.last(ask.sessionId, 200),
        });
      }
    }
    app.broker.resolveAsk(resolved, resolution);
    return {};
  });

  bus.register('terminal.spawn', async ({ worktreeId }) => ({
    terminalId: await terminals.spawn(worktreeId),
  }));

  bus.register('terminal.input', ({ terminalId, data }) => {
    terminals.input(terminalId, data);
    return {};
  });

  bus.register('terminal.resize', ({ terminalId, cols, rows }) => {
    terminals.resize(terminalId, cols, rows);
    return {};
  });

  bus.register('terminal.kill', ({ terminalId }) => {
    terminals.kill(terminalId);
    return {};
  });
}

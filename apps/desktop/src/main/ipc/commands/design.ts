import type { Container } from '../../container';
import type { CommandBus } from '../bus';

/** design.* — the Design tab (#140). */
export function registerDesignCommands(bus: CommandBus, app: Container): void {
  bus.register('design.list', ({ worktreeId }) => app.design.list(worktreeId));
  bus.register('design.read', ({ worktreeId, path }) => app.design.read(worktreeId, path));
  bus.register('design.write', ({ worktreeId, path, html }) => {
    app.design.write(worktreeId, path, html);
    return {};
  });
  bus.register('design.setTokens', ({ worktreeId, tokens }) => {
    app.design.setTokens(worktreeId, tokens);
    return {};
  });
  bus.register('design.capture', async ({ rect }, ctx) => {
    const png = await app.captureWindow(ctx.senderId, rect);
    return { image: png === null ? null : png.toString('base64') };
  });
  bus.register('design.handover', async (input) => ({ sessionId: await app.design.handover(input) }));
}

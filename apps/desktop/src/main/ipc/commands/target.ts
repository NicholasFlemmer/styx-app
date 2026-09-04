import type { Container } from '../../container';
import type { CommandBus } from '../bus';

/** target.* */
export function registerTargetCommands(bus: CommandBus, app: Container): void {
  const { targets } = app;

  bus.register('target.connect.start', ({ projectId, provider, env, name }) => {
    const r = targets.connectStart(projectId, provider, env, name);
    return { flowId: r.flowId, authMethod: r.authMethod, browserUrl: r.browserUrl };
  });

  bus.register('target.connect.saveKey', async (input) => ({ targetId: (await targets.saveKey(input)).id }));

  bus.register('target.connect.saveSsh', async (input) => ({ targetId: (await targets.saveSsh(input)).id }));

  bus.register('target.test', ({ targetId }) => targets.test(targetId));

  bus.register('target.setPolicy', ({ targetId, policy }) => {
    targets.setPolicy(targetId, policy);
    return {};
  });

  bus.register('target.remove', async ({ targetId }) => {
    await targets.remove(targetId);
    return {};
  });

  bus.register('target.reconnect', ({ targetId }) => targets.reconnect(targetId));
}

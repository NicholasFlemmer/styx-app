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

  bus.register('target.connect.saveToken', async ({ targetId, token }) => ({
    targetId: (await targets.saveToken(targetId, token)).id,
  }));

  bus.register('target.connect.saveSsh', async ({ passphrase, ...rest }) => ({
    // exactOptionalPropertyTypes: an absent passphrase must be absent, not `undefined`.
    targetId: (await targets.saveSsh({ ...rest, ...(passphrase !== undefined ? { passphrase } : {}) })).id,
  }));

  bus.register('target.connect.cliStatus', ({ provider }) => targets.cliStatus(provider));

  bus.register('target.connect.cliLogin', ({ projectId, provider, account }) =>
    targets.cliLogin(projectId, provider, account),
  );

  bus.register('target.connect.cliSave', async (input) => ({ targetId: (await targets.cliSave(input)).id }));

  bus.register('target.test', ({ targetId }) => targets.test(targetId));

  bus.register('target.refresh', ({ targetId }) => targets.refresh(targetId));

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

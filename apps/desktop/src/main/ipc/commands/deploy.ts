import { copy } from '@styx/core';
import type { Container } from '../../container';
import type { CommandBus } from '../bus';

/** Deploy commands. The grant, the audit row and the MFA gate all happen inside DeployService. */
export function registerDeployCommands(bus: CommandBus, app: Container): void {
  bus.register('deploy.start', async ({ targetId }) => app.deploys.start(targetId, copy.deploy.reason));

  bus.register('deploy.detect', async ({ targetId }) => ({
    suggestions: await app.deploys.detect(targetId),
  }));
  bus.register('deploy.cancel', ({ deployId }) => {
    app.deploys.cancel(deployId);
    return {};
  });
}

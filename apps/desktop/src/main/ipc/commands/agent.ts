import type { Container } from '../../container';
import type { CommandBus } from '../bus';

/** agent.* — one connection per agent CLI: verify who it is signed in as, sign in, install, open the install guide. */
export function registerAgentCommands(bus: CommandBus, app: Container): void {
  bus.register('agent.verify', async ({ agent }) => ({ cli: await app.agents.verify(agent) }));
  bus.register('agent.login', ({ agent }) => app.agents.login(agent));
  bus.register('agent.install', ({ agent }) => app.agents.install(agent));
  bus.register('agent.installGuide', async ({ agent }) => {
    await app.agents.installGuide(agent);
    return {};
  });
}

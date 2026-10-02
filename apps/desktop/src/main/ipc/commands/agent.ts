import type { Container } from '../../container';
import type { CommandBus } from '../bus';

/** agent.* — one connection per agent CLI: verify who it is signed in as, sign in, install, open the install guide. */
export function registerAgentCommands(bus: CommandBus, app: Container): void {
  bus.register('agent.verify', async ({ agent }) => ({ cli: await app.agents.verify(agent) }));
  bus.register('agent.login', ({ agent }) => app.agents.login(agent));
  bus.register('agent.install', ({ agent }) => app.agents.install(agent));
  // Agent setup (owner request): the run goes on in the background; its progress is the `agentSetup.set` delta.
  bus.register('agent.setUp', ({ agent, update }) => {
    void app.agentSetup.setUp(agent, { update });
    return {};
  });
  bus.register('agent.setUpCancel', ({ agent }) => {
    app.agentSetup.cancel(agent);
    return {};
  });
  bus.register('agent.setUpCode', ({ agent, code }) => {
    app.agentSetup.code(agent, code);
    return {};
  });
  bus.register('agent.setUpPlans', async ({ agent }) => {
    await app.agentSetup.plans(agent);
    return {};
  });
  bus.register('agent.installGuide', async ({ agent }) => {
    await app.agents.installGuide(agent);
    return {};
  });
}

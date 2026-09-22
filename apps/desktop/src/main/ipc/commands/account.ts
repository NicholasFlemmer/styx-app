import type { Container } from '../../container';
import type { CommandBus } from '../bus';

/**
 * Account commands (ADR-0026). `signIn` returns as soon as the code is on screen — the polling runs on in main
 * and publishes each state change — so the renderer is never blocked waiting on a person in a browser.
 */
export function registerAccountCommands(bus: CommandBus, app: Container): void {
  bus.register('account.signIn', async ({ provider }) => {
    await app.account.signIn(provider);
    return {};
  });

  bus.register('account.cancelSignIn', () => {
    app.account.cancelSignIn();
    return {};
  });

  bus.register('account.openVerification', () => {
    app.account.openVerification();
    return {};
  });

  bus.register('account.signOut', async () => {
    await app.account.signOut();
    return {};
  });

  bus.register('account.refresh', async () => {
    await app.account.refresh();
    return {};
  });
}

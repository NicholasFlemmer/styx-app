import type { Container } from '../../container';
import type { CommandBus } from '../bus';

/** Feedback (owner request, #123): the dialog's Send. The failure reason reaches the dialog as the error message. */
export function registerFeedbackCommands(bus: CommandBus, app: Container): void {
  bus.register('feedback.send', async ({ message, email }) => {
    await app.feedback.send(message, email === undefined || email === '' ? null : email);
    return {};
  });
}

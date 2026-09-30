import type { Container } from '../../container';
import type { CommandBus } from '../bus';

/** Feedback (owner request, #123): the dialog's Send. The failure reason reaches the dialog as the error message. */
export function registerFeedbackCommands(bus: CommandBus, app: Container): void {
  bus.register('feedback.send', async ({ message, email, diagnostics }) => {
    await app.feedback.send(message, email === undefined || email === '' ? null : email, diagnostics);
    return {};
  });
  // The walkthrough's counts (#125): a closed list, and nothing is kept while counts are off.
  bus.register('usage.note', ({ event }) => {
    app.usageReports.record(event);
    return {};
  });
}

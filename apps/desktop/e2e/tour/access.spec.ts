/**
 * Tour: an agent asks for production and you grant it once. Codex's demo task waits on a Supabase prod request; the
 * request opens as a sheet with the reason and the scope, Grant once is pressed, and the grant lands in the chat.
 */
import { test } from '@playwright/test';
import { startTour, steps } from './tour';

test('tour: access request granted once', async () => {
  const t = await startTour('access', { screen: 'workspace' });
  try {
    const { page } = t;
    await steps.workspaceReady(page);
    await steps.restPointer(page);
    const card = steps.card(page, 'Fix the flaky order test');
    await t.reach('board', steps.board(page), { card });
    await t.reach('card-waiting', card, { chip: card.getByText('Requesting Supabase prod') });

    await card.click();
    const review = page.getByRole('button', { name: /^review request$/i });
    await steps.restPointer(page);
    const chat = page.locator('[data-chat-pane]');
    await t.reach('chat-request', chat, { review });

    await review.click();
    const sheet = page.getByRole('dialog', { name: /supabase/i });
    await steps.restPointer(page);
    const grant = sheet.getByRole('button', { name: /^grant/i });
    await t.reach('access-sheet', sheet, {
      reason: sheet.getByText(/to run migration/),
      scope: sheet.getByText('Write', { exact: true }),
      duration: sheet.getByRole('radio', { name: 'once' }),
      grant,
    });

    // Pressed, held: the button as it looks under a finger.
    const g = await grant.boundingBox();
    if (!g) throw new Error('tour access: Grant button not on screen');
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await t.reach('grant-pressed', sheet, { grant });
    await page.mouse.up();

    const line = page.getByText(/grant: supabase-prod · read\+write/).first();
    await line.waitFor();
    await steps.restPointer(page);
    await t.reach('chat-granted', chat, { line });
    await t.reach('grant-line', line);

    // The same grant, in the audit log.
    await page
      .getByRole('navigation', { name: 'App' })
      .getByRole('button', { name: /^Access/ })
      .click();
    await page.getByRole('tab', { name: 'Audit log' }).click();
    await steps.restPointer(page);
    const log = page.getByRole('table', { name: 'Audit log' });
    const granted = log
      .getByRole('row')
      .filter({ hasText: /supabase-prod/ })
      .first();
    await granted.waitFor();
    await t.reach('audit-granted', log, { granted, first: log.getByRole('row').first() });
  } finally {
    await t.close();
  }
});

/**
 * Tour: the Access page. Every request agents make, across projects; the policies that answer some on their own; and
 * the audit log of every grant, use and revoke.
 */
import { test } from '@playwright/test';
import { startTour, steps } from './tour';

test('tour: access requests, policies and the audit log', async () => {
  const t = await startTour('approvals', { screen: 'home' });
  try {
    const { page } = t;
    await steps.homeReady(page);
    await page
      .getByRole('navigation', { name: 'App' })
      .getByRole('button', { name: /^Access/ })
      .click();
    await steps.restPointer(page);
    const requests = page.getByRole('table', { name: 'Requests' });
    const rows = requests.getByRole('row');
    await t.reach('requests', requests, { codex: rows.nth(0), claude: rows.nth(1), cursor: rows.nth(2) });
    for (const [k, who] of ['codex', 'claude', 'cursor'].entries())
      await t.reach(`request-${who}`, rows.nth(k));
    const policies = page.getByRole('complementary', { name: 'Policies' });
    await t.reach('policies', policies, {
      staging: policies.getByText(/^Auto-approve read/),
      prod: policies.getByText(/^Always ask, require/),
      expire: policies.getByText(/^Expire grants/),
    });
    await page.getByRole('tab', { name: 'Audit log' }).click();
    await steps.restPointer(page);
    const log = page.getByRole('table', { name: 'Audit log' });
    const entries = log.getByRole('row');
    await t.reach('audit-log', log, {
      first: entries.nth(0),
      granted: entries.nth(1),
      revoked: entries.nth(2),
      pr: entries.nth(3),
    });
    // Review the Codex request from the list: its button held, then the sheet it opens (in the task), Grant held.
    await page.getByRole('tab', { name: /^Requests/ }).click();
    const review = rows.nth(0).getByRole('button', { name: 'Review' });
    await steps.pressHold(page, review, () =>
      t.reach('requests-review-pressed', requests, { codex: rows.nth(0), review }),
    );
    await review.click();
    const sheet = page.getByRole('dialog', { name: /supabase/i });
    await steps.restPointer(page);
    const grant = sheet.getByRole('button', { name: /^grant/i });
    await t.reach('review-sheet', sheet, { reason: sheet.getByText(/to run migration/), grant });
    await steps.pressHold(page, grant, () => t.reach('review-grant-pressed', sheet, { grant }));
    await page.keyboard.press('Escape');
  } finally {
    await t.close();
  }
});

/** Tour: usage. Sessions, turns, tokens and cost by agent and by project, from the sessions Styx ran. */
import { test } from '@playwright/test';
import { startTour } from './tour';

test('tour: usage by agent and project', async () => {
  const t = await startTour('usage', { screen: 'usage' });
  try {
    const { page } = t;
    await page.locator('[data-screen-ready="usage"]').waitFor({ state: 'attached' });
    await page.mouse.move(2, 2);
    await t.reach('by-agent', page.locator('[data-usage-table="agent"]'), {
      total: page.locator('[data-usage-table="agent"] [data-usage-total]'),
    });
    await t.reach('by-project', page.locator('[data-usage-table="project"]'));
  } finally {
    await t.close();
  }
});

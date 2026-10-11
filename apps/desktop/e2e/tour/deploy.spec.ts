/** Tour: deploying from the lane. The Deploy menu lists the project's targets, prod ones locked until granted. */
import { expect, test } from '@playwright/test';
import { startTour, steps } from './tour';

test('tour: the deploy menu', async () => {
  const t = await startTour('deploy', { screen: 'workspace' });
  try {
    const { page } = t;
    await steps.workspaceReady(page);
    const button = page.locator('[data-deploy-button] > button');
    await t.reach('deploy-button', button);
    await button.click();
    const menu = page.locator('[data-deploy-menu]');
    await expect(menu.getByRole('menuitem').first()).toBeVisible();
    await steps.restPointer(page);
    const items = menu.getByRole('menuitem');
    await t.reach('deploy-menu', menu, { first: items.nth(0), second: items.nth(1), third: items.nth(2) });
    await page.keyboard.press('Escape');
  } finally {
    await t.close();
  }
});

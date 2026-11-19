/**
 * One place for the work (ADR-0033): the setting swaps the shell, every page paints and passes axe, and the way back
 * restores classic Styx. `STYX_ONE_SHOTS=<dir>` also saves a screenshot of each page there, for looking at.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { launchStyx } from './launch';

const PAGES = [
  ['Home', 'one-home'],
  ['Needs your OK', 'one-needs'],
  ['Tasks', 'one-tasks'],
  ['Projects', 'one-projects'],
  ['Connected apps', 'one-apps'],
  ['Record', 'one-record'],
] as const;

test('One place for the work: switch on, visit every page, switch back', async () => {
  const { app, page } = await launchStyx();
  const shots = process.env['STYX_ONE_SHOTS'];
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForSelector('[data-screen-ready]');
    await page.evaluate(() => window.styx.command('settings.set', { patch: { oneMode: true } }));
    const nav = page.locator('[data-one-nav]');
    await expect(nav).toBeVisible();
    await expect(page.locator('[data-rails]')).toHaveCount(0);
    for (const [label, screen] of PAGES) {
      await nav.getByRole('button', { name: label, exact: false }).first().click();
      await page.waitForSelector(`[data-screen-ready="${screen}"]`);
      if (shots) await page.screenshot({ path: `${shots}/${screen}.png` });
      const axe = await new AxeBuilder({ page })
        .setLegacyMode(true)
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(axe.violations.map((v) => `${screen}: ${v.id}`)).toEqual([]);
    }
    await nav.getByRole('button', { name: 'acme-shop' }).click();
    await page.waitForSelector('[data-screen-ready="one-project"]');
    if (shots) await page.screenshot({ path: `${shots}/one-project.png` });
    // A task opens the workspace inside the same sidebar.
    await page.locator('[data-one-task]').first().click();
    await page.waitForSelector('[data-screen-ready="workspace"]');
    await expect(nav).toBeVisible();
    if (shots) await page.screenshot({ path: `${shots}/one-task.png` });
    await nav.getByRole('button', { name: 'Back to classic Styx' }).click();
    await expect(page.locator('[data-rails]')).toBeVisible();
    await expect(nav).toHaveCount(0);
  } finally {
    await app.close();
  }
});

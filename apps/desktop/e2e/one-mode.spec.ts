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
    // A task opens in plain view; its details are the workspace, inside the same sidebar.
    await page.locator('[data-one-task]').first().click();
    await page.waitForSelector('[data-screen-ready="one-task"]');
    if (shots) await page.screenshot({ path: `${shots}/one-task.png` });
    const axe = await new AxeBuilder({ page })
      .setLegacyMode(true)
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(axe.violations.map((v) => `one-task: ${v.id}`)).toEqual([]);
    await page.getByRole('button', { name: 'Show the details' }).click();
    await page.waitForSelector('[data-screen-ready="workspace"]');
    await expect(nav).toBeVisible();
    if (shots) await page.screenshot({ path: `${shots}/one-details.png` });
    await nav.getByRole('button', { name: 'Back to classic Styx' }).click();
    await expect(page.locator('[data-rails]')).toBeVisible();
    await expect(nav).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('One place for the work: a campaign and a report draw as results', async () => {
  const { app, page } = await launchStyx({ fixture: 'one' });
  const shots = process.env['STYX_ONE_SHOTS'];
  const axe = async (name: string) => {
    const r = await new AxeBuilder({ page })
      .setLegacyMode(true)
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(r.violations.map((v) => `${name}: ${v.id}`)).toEqual([]);
  };
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    const nav = page.locator('[data-one-nav]');
    await expect(nav).toBeVisible();
    await nav.getByRole('button', { name: 'Home' }).click();
    await page.waitForSelector('[data-screen-ready="one-home"]');
    if (shots) await page.screenshot({ path: `${shots}/one-home-fixture.png` });
    await nav.getByRole('button', { name: 'Connected apps' }).click();
    await page.waitForSelector('[data-one-app-card="notion"]');
    if (shots) await page.screenshot({ path: `${shots}/one-apps-cards.png` });
    await axe('one-apps-cards');
    // Manage opens the app's panel at the top, in view.
    await page.getByRole('button', { name: 'Manage Notion' }).click();
    await expect(page.locator('[data-one-app-detail="demo-notion"]')).toBeInViewport();
    if (shots) await page.screenshot({ path: `${shots}/one-apps-manage.png` });
    await nav.getByRole('button', { name: 'Results' }).click();
    await page.waitForSelector('[data-screen-ready="one-results"]');
    await expect(page.locator('[data-one-result-card]')).toHaveCount(3);
    if (shots) await page.screenshot({ path: `${shots}/one-results.png` });
    await axe('one-results');
    await page.locator('[data-one-result-card]', { hasText: 'Black Friday' }).click();
    await page.waitForSelector('[data-one-result="campaign"]');
    await expect(page.locator('[data-one-launch="open"]')).toContainText('at most');
    if (shots) await page.screenshot({ path: `${shots}/one-campaign.png` });
    await axe('one-campaign');
    // A live campaign: its numbers, and Pause everything.
    await nav.getByRole('button', { name: 'Results' }).click();
    await page.locator('[data-one-result-card]', { hasText: 'Winter sale' }).click();
    await expect(page.locator('[data-one-campaign-state="live"]')).toBeVisible();
    await expect(page.locator('[data-one-campaign-state="live"]')).toContainText('R');
    if (shots) await page.screenshot({ path: `${shots}/one-campaign-live.png` });
    await axe('one-campaign-live');
    await page.getByRole('button', { name: 'Pause everything' }).click();
    await expect(page.locator('[data-one-campaign-state="paused"]')).toBeVisible();
    await nav.getByRole('button', { name: 'Results' }).click();
    await page.locator('[data-one-result-card]', { hasText: 'Weekly report' }).click();
    await page.waitForSelector('[data-one-result="report"]');
    await expect(page.getByRole('button', { name: 'Download PDF' })).toBeVisible();
    await page.getByRole('button', { name: 'Keep it updating every Monday' }).click();
    await expect(page.locator('[data-one-result="report"]')).toContainText('Updating weekly');
    if (shots) await page.screenshot({ path: `${shots}/one-report.png` });
    await axe('one-report');
  } finally {
    await app.close();
  }
});

import { expect, test } from '@playwright/test';
import { launchStyx } from './launch';

/**
 * The first-run walkthrough (#124), played from the palette: every step points at something on Home, the keys
 * move through it, and it closes itself after the last card. (It never starts by itself under the harness.)
 */
test('walkthrough: palette → six steps on Home → closes, and does not start by itself', async () => {
  const { app, page } = await launchStyx({ screen: 'home', env: { STYX_DEMO_REPOS: '0' } });
  await page.waitForSelector('[data-screen-ready="home"]');
  await page.waitForTimeout(1200);
  await expect(page.locator('[data-tour="true"]')).toHaveCount(0);

  await page.keyboard.press('Meta+K');
  await page.keyboard.type('walkthrough');
  await page.keyboard.press('Enter');
  const tour = page.locator('[data-tour="true"]');
  await expect(tour).toHaveAttribute('data-tour-step', 'rail');
  await expect(page.getByRole('dialog', { name: 'Every project, one window' })).toBeVisible();

  const seen: string[] = [];
  for (let i = 0; i < 6; i++) {
    seen.push((await tour.getAttribute('data-tour-step')) ?? '');
    await page.keyboard.press('ArrowRight');
  }
  expect(seen).toEqual(['rail', 'needs', 'agents', 'approvals', 'palette', 'done']);
  await expect(tour).toHaveCount(0);
  await app.close();
});

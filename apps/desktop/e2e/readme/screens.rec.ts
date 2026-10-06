/**
 * Still screenshots for the README (`pnpm -F @styx/desktop readme:gif` takes them too): the demo data at 1280×800,
 * written to `.github/assets/`.
 */
import { resolve } from 'node:path';
import { test } from '@playwright/test';
import { launchStyx } from '../launch';

const ASSETS = resolve(__dirname, '../../../../.github/assets');

test('README: every project, one window', async () => {
  const { app, page } = await launchStyx({
    screen: 'home',
    theme: 'dark',
    chrome: 'mac',
    env: { STYX_DEMO_REPOS: '0' },
  });
  await page.waitForSelector('[data-screen-ready="home"]');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${ASSETS}/readme-projects.jpg`, type: 'jpeg', quality: 90 });
  await app.close();
});

import { test, expect } from '@playwright/test';
import { launchStyx } from './launch';

test('app launches with a themed window and bundled fonts', async () => {
  const { app, page } = await launchStyx();
  await expect(page).toHaveTitle('Styx');
  const theme = await page.evaluate(() => document.documentElement.dataset['theme']);
  expect(['dark', 'light']).toContain(theme);
  const fontOk = await page.evaluate(async () => {
    await (document as Document & { fonts: FontFaceSet }).fonts.load('600 13px Archivo');
    return (document as Document & { fonts: FontFaceSet }).fonts.check('600 13px Archivo');
  });
  expect(fontOk).toBe(true);
  const size = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
  expect(size[0]).toBeGreaterThanOrEqual(1100);
  await page.screenshot({ path: 'test-results/smoke.png' });
  await app.close();
});

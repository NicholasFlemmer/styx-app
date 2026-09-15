/**
 * "Run locally" (owner request): the design window starts the project's dev server itself instead of asking
 * for a URL. The seeded acme-shop repo gets a package.json whose `dev` script prints a localhost URL; main must
 * detect `npm run dev`, run it through the login shell, sniff the URL into the status bar, and stop it on ■.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { launchStyx } from './launch';

test('Run locally detects the command, surfaces the URL in the status bar, and Stop ends it', async () => {
  const { app, page, userData } = await launchStyx({ screen: 'workspace', fixture: 'demo', theme: 'dark' });
  // The harness materialises the demo repos under userData at boot; the script is written after that.
  const repo = join(userData, 'demo-repos', 'acme-shop');
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify(
      {
        name: 'acme-shop',
        private: true,
        scripts: { dev: `node -e "console.log('ready http://localhost:3999'); setInterval(()=>{},1000)"` },
      },
      null,
      2,
    ),
  );

  await page.waitForSelector('[data-workspace-mode="design"]', { timeout: 10_000 });
  await page.click('[data-workspace-mode="design"]');

  // `getByLabel('Command')` also matches the titlebar's "Open command palette"; the field carries its own hook.
  const command = page.locator('[data-run-command]');
  await expect(command).toHaveValue('npm run dev', { timeout: 10_000 });
  await expect(command).toHaveAttribute('title', 'Detected from package.json');

  await page.click('[data-run-start]');
  const strip = page.locator('[data-run-strip]');
  await expect(strip).toBeVisible({ timeout: 10_000 });
  const bar = page.locator('[data-status-bar]');
  await expect(bar).toContainText('dev · http://localhost:3999', { timeout: 20_000 });
  await expect(page.locator('[data-run-phase]')).toHaveText('Running · http://localhost:3999');
  // The URL the server printed is now the design window's URL.
  await expect(page.getByLabel('Dev server URL')).toHaveValue('http://localhost:3999');

  await page.click('[data-run-stop]');
  await expect(page.locator('[data-run-phase]')).toContainText('Exited', { timeout: 20_000 });
  await expect(bar).not.toContainText('dev ·');
  await expect(page.locator('[data-run-start]')).toBeVisible();

  await page.click('[data-run-dismiss]');
  await expect(strip).toHaveCount(0);

  await app.close();
});

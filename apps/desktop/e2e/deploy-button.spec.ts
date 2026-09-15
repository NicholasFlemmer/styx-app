/**
 * The workspace deploy button (owner request): it must say where it deploys. acme-shop's prod target is
 * Vercel prod → "Deploy to live · Vercel prod"; infra-tools has only AWS and GCP, which have no deploy verb, so
 * the button is disabled and says what to connect.
 */
import { test, expect } from '@playwright/test';
import { launchStyx } from './launch';

test('names the prod target on acme-shop and is disabled where nothing can be deployed', async () => {
  const { app, page } = await launchStyx({ screen: 'workspace', fixture: 'demo', theme: 'dark' });
  await page.waitForSelector('[data-deploy-button]', { timeout: 10_000 });

  const button = page.locator('[data-deploy-button] button');
  await expect(button).toHaveText('▲Deploy to live · Vercel prod');
  await expect(button).toBeEnabled();
  await expect(page.locator('[data-deploy-button]')).toHaveAttribute('data-state', 'single');

  // The button sits at the right end of the Code / Design strip.
  const strip = await page.locator('[role="tablist"]:has([data-workspace-mode])').boundingBox();
  const box = await button.boundingBox();
  expect(strip).not.toBeNull();
  expect(box).not.toBeNull();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeGreaterThan((strip?.x ?? 0) + (strip?.width ?? 0) / 2);

  // Clicking starts a deploy: the modal opens named for the target.
  await button.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Deploy · Vercel prod', { timeout: 5_000 });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // infra-tools: aws + gcp only, no deploy command yet → the button offers setup and opens the per-target modal.
  // Rail tiles carry the project name as their title.
  await page.click('[data-rail] [title="infra-tools"]');
  await expect(page.locator('[data-deploy-button]')).toHaveAttribute('data-state', 'setup', {
    timeout: 10_000,
  });
  await expect(button).toBeEnabled();
  await expect(button).toHaveText('▲Set up deploy');
  await button.click();
  const setup = page.getByRole('dialog');
  await expect(setup).toContainText('Deploy · infra-tools', { timeout: 5_000 });
  await expect(setup.getByLabel('Deploy command').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(setup).toHaveCount(0);

  await app.close();
});

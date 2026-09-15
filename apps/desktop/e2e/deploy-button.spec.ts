/**
 * The workspace deploy button (owner request): it must say where it deploys, and it works the way asking an agent
 * does. acme-shop has three prod targets → a picker; choosing Vercel prod (built in) opens the deploy modal.
 * infra-tools has one prod target, AWS, with no deploy command yet → the same "Deploy to live" button, flagged to
 * hand the first deploy to the agent (not clicked here: it would launch a real CLI).
 */
import { test, expect } from '@playwright/test';
import { launchStyx } from './launch';

test('picks among prod targets on acme-shop; a target without a command is still a live deploy button', async () => {
  const { app, page } = await launchStyx({ screen: 'workspace', fixture: 'demo', theme: 'dark' });
  await page.waitForSelector('[data-deploy-button]', { timeout: 10_000 });

  const button = page.locator('[data-deploy-button] > button');
  await expect(button).toContainText('Deploy to');
  await expect(button).toBeEnabled();
  await expect(page.locator('[data-deploy-button]')).toHaveAttribute('data-state', 'menu');

  // The button sits at the right end of the Code / Design strip.
  const strip = await page.locator('[role="tablist"]:has([data-workspace-mode])').boundingBox();
  const box = await button.boundingBox();
  expect(strip).not.toBeNull();
  expect(box).not.toBeNull();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeGreaterThan((strip?.x ?? 0) + (strip?.width ?? 0) / 2);

  // Every prod target is offered; the ones Styx has no command for are flagged to learn.
  await button.click();
  const menu = page.locator('[data-deploy-menu]');
  await expect(menu).toBeVisible();
  const items = menu.getByRole('menuitem');
  await expect(items).toHaveText(['Vercel prod', 'Supabase prod', 'AWS acme-prod prod']);
  await expect(items.nth(0)).not.toHaveAttribute('data-learn', 'true');
  await expect(items.nth(1)).toHaveAttribute('data-learn', 'true');

  // Choosing the built-in one starts a deploy: the modal opens named for the target.
  await items.nth(0).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Deploy · Vercel prod', { timeout: 5_000 });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // infra-tools: one prod target (AWS), no command yet → "Deploy to live · AWS acme-prod prod", agent-first.
  // Rail tiles carry the project name as their title.
  await page.click('[data-rail] [title="infra-tools"]');
  await expect(page.locator('[data-deploy-button]')).toHaveAttribute('data-state', 'single', {
    timeout: 10_000,
  });
  await expect(page.locator('[data-deploy-button]')).toHaveAttribute('data-learn', 'true');
  await expect(button).toBeEnabled();
  await expect(button).toHaveText('▲Deploy to live · AWS acme-prod prod');

  await app.close();
});

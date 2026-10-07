/**
 * The workspace deploy button (owner request): it must say where it deploys, and it works the way asking an agent
 * does. acme-shop has five targets → a picker listing all of them, non-prod first and prod last (issue #9: it
 * used to list only the prod ones); choosing Vercel prod (built in) opens the deploy modal. infra-tools has AWS
 * prod + GCP staging → a picker by keyboard, staging first, and opening it deploys nothing. side-api has one
 * staging target with no deploy command yet → a single `Deploy · Supabase staging` button, flagged to hand the
 * first deploy to the agent (not clicked here: it would launch a real CLI).
 */
import { test, expect } from '@playwright/test';
import { launchStyx } from './launch';

test('lists every target, prod last; opening the picker deploys nothing; one target is a single button', async () => {
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

  // Every target is offered, prod last below a rule; the ones Styx has no command for are flagged to learn.
  await button.click();
  const menu = page.locator('[data-deploy-menu]');
  await expect(menu).toBeVisible();
  const items = menu.getByRole('menuitem');
  await expect(items).toHaveText([
    'Vercel preview',
    'GitHub acme/shop scm',
    'Vercel prod',
    'Supabase prod',
    'AWS acme-prod prod',
  ]);
  await expect(items.nth(0)).not.toHaveAttribute('data-learn', 'true');
  await expect(items.nth(1)).toHaveAttribute('data-learn', 'true');
  await expect(items.nth(2)).toHaveAttribute('data-prod', 'true');
  await expect(menu.getByRole('separator')).toHaveCount(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Choosing the built-in prod one starts a deploy: the modal opens named for the target.
  await items.nth(2).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Deploy · Vercel prod', { timeout: 5_000 });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // infra-tools (issue #9): AWS prod + GCP staging. It used to be a one-click "Deploy to live · AWS"; now the
  // keyboard opens a picker on the staging row and nothing deploys until a row is chosen.
  // Rail tiles carry the project name as their title.
  await page.click('[data-rail] [title="infra-tools"]');
  await expect(page.locator('[data-deploy-button]')).toHaveAttribute('data-state', 'menu', {
    timeout: 10_000,
  });
  await button.focus();
  await page.keyboard.press('ArrowDown');
  await expect(items).toHaveText(['GCP infra staging', 'AWS acme-prod prod']);
  await expect(items.nth(0)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // side-api: one staging target (Supabase), no command yet → a single "Deploy · Supabase staging", agent-first.
  await page.click('[data-rail] [title="side-api"]');
  await expect(page.locator('[data-deploy-button]')).toHaveAttribute('data-state', 'single', {
    timeout: 10_000,
  });
  await expect(page.locator('[data-deploy-button]')).toHaveAttribute('data-learn', 'true');
  await expect(button).toBeEnabled();
  await expect(button).toHaveText('▲Deploy · Supabase staging');

  await app.close();
});

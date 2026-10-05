/**
 * Signing in (owner request, discrepancy #113): the dialog is the conventional one, and Settings › Account is for
 * managing an account rather than getting one. Since #148 the account gates nothing: signed out, every project
 * route opens straight away.
 * `STYX_API` points at a port nothing is listening on, so no sign-in can complete and none of this needs one.
 */
import { test, expect } from '@playwright/test';
import { launchStyx } from './launch';

const OFFLINE_API = 'http://127.0.0.1:9';

test('the Account pane manages an account; the dialog is where one is got', async () => {
  const { app, page } = await launchStyx({
    screen: 'settings',
    fixture: 'empty',
    theme: 'dark',
    env: { STYX_E2E: '0', STYX_API: OFFLINE_API },
  });
  await page.click('[data-app-rail-item="settings"]');
  await page.click('[data-settings-nav-item="app:account"]');
  const pane = page.locator('[data-account="signed-out"]');
  await expect(pane).toBeVisible();
  // The providers are not on the pane any more.
  await expect(page.locator('[data-account-signin="github"]')).toHaveCount(0);

  await page.locator('[data-account-signin]').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Sign in to Styx');
  await expect(page.locator('[data-sign-in-provider="github"]')).toBeVisible();
  await expect(page.locator('[data-sign-in-provider="google"]')).toBeVisible();

  // Picking a provider keeps you in the same dialog, now showing the code the API minted.
  // Offline here, so it comes back to the providers with a reason rather than a code.
  await page.locator('[data-sign-in-provider="github"]').click();
  await expect(page.locator('[data-sign-in-error]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-sign-in-provider="github"]')).toBeVisible();

  // Not now closes it and leaves the app exactly as it was.
  await page.locator('[data-sign-in-later]').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(pane).toBeVisible();

  await app.close();
});

test('signed out, adding another project opens straight away: the account gates nothing (#148)', async () => {
  const { app, page } = await launchStyx({
    screen: 'home',
    fixture: 'demo',
    theme: 'dark',
    env: { STYX_E2E: '0', STYX_API: OFFLINE_API },
  });
  await page.waitForSelector('[data-rail]', { timeout: 10_000 });
  await page.evaluate(() => window.styx?.command('account.signOut', {}));
  await page.waitForTimeout(500); // the sign-out delta has to land before the rail is asked

  // Signed out with five projects already there: the rail's + still opens the new-project modal.
  await page.click('[data-rail-add]');
  await page.locator('[data-rail-add-menu] [role="menuitem"]').first().click();
  await expect(page.locator('[data-new-project-modal]')).toBeVisible();
  await expect(page.getByRole('dialog')).not.toContainText('Sign in to Styx');

  await app.close();
});

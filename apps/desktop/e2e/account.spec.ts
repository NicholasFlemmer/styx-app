/**
 * The Styx account (ADR-0026). The demo fixture is signed in, so the pane shows a person; the empty fixture is
 * not, so it shows what an account is for. Nothing here reaches the network: `STYX_API` points at a port
 * nothing is listening on, which is also the honest test of "the app carries on when the API is unreachable".
 */
import { test, expect } from '@playwright/test';
import { launchStyx } from './launch';

const OFFLINE_API = 'http://127.0.0.1:9';

test('signed in: the pane shows the account, and an unreachable API never breaks the app', async () => {
  const { app, page } = await launchStyx({
    screen: 'settings',
    fixture: 'demo',
    theme: 'dark',
    env: { STYX_E2E: '0', STYX_API: OFFLINE_API },
  });
  await page.click('[data-app-rail-item="settings"]');
  await page.click('[data-settings-nav-item="app:account"]');
  const pane = page.locator('[data-account="signed-in"]');
  await expect(pane).toBeVisible();
  await expect(pane).toContainText('Nic Flemmer');
  await expect(pane).toContainText('nic@acme.dev');
  await expect(pane).toContainText('Signed in with GitHub');

  // Refresh cannot reach the API: the session stands and the pane says it is offline.
  await expect(page.locator('[data-account-stale]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('[data-account-stale]')).toBeVisible({ timeout: 10_000 });
  await expect(pane).toContainText('Nic Flemmer');

  // The rest of the app is untouched by any of it.
  await page.click('[data-app-rail-item="home"]');
  // Home's counters: the app is still running normally with an account it cannot confirm.
  await expect(page.getByText('Needs you').first()).toBeVisible({ timeout: 10_000 });

  await app.close();
});

test('signed out: the pane points at the dialog, and a sign-in that cannot reach the API says so', async () => {
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

  // Getting an account is the dialog's job now (discrepancy #113); the pane only points at it.
  await page.locator('[data-account-signin]').click();
  await expect(page.locator('[data-sign-in-provider="github"]')).toBeVisible();
  await expect(page.locator('[data-sign-in-provider="google"]')).toBeVisible();

  await page.locator('[data-sign-in-provider="github"]').click();
  // No server to answer, so the flow never starts and the dialog says why, still offering both providers.
  await expect(page.locator('[data-sign-in-error]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-sign-in-provider="github"]')).toBeVisible();

  await app.close();
});

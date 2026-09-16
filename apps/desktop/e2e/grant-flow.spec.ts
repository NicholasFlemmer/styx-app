import { expect, test } from '@playwright/test';
import { launchStyx } from './launch';

/**
 * The README's demo path: Codex tab → Review request → Grant. Approving anywhere must resolve everywhere
 * (chat system line, board, inbox count, audit, target state, counters) — spec §4.1 / README "Interactions".
 */
test('grant flow propagates through chat, counters, approvals, audit and targets; revoke locks again', async () => {
  const { app, page } = await launchStyx({
    screen: 'workspace',
    env: { STYX_MFA: 'auto', STYX_DEMO_REPOS: '0' },
  });
  await page.waitForSelector('[data-screen-ready="workspace"]');

  const needsYou = page.getByText(/02 needs you/i).first();
  await expect(needsYou).toBeVisible();

  await page.getByRole('tab', { name: /codex/i }).click();
  await page.getByRole('button', { name: /^review request$/i }).click();
  const sheet = page.getByRole('dialog', { name: /supabase/i });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: /^grant/i }).click();

  await expect(page.getByText(/grant: supabase-prod · read\+write · expires in (1h|\d+m)/)).toBeVisible();
  await expect(page.getByText(/01 needs you/i).first()).toBeVisible();
  await expect(page.getByText(/01 locked/i).first()).toBeVisible();

  await page.getByRole('button', { name: /^approvals/i }).click();
  await page.waitForSelector('[data-screen-ready="approvals"]');
  await expect(page.getByRole('tab', { name: /inbox · 2/i })).toBeVisible();
  await page.getByRole('tab', { name: /audit log/i }).click();
  await expect(page.getByText(/granted read\+write to Codex · 1h/)).toBeVisible();

  await page.getByRole('button', { name: /^project settings/i }).click();
  await page.waitForSelector('[data-screen-ready="settings"]');
  const supabaseRow = page.getByRole('row', { name: /supabase/i }).first();
  await expect(supabaseRow.getByText(/open · (1h|\d+m) left/)).toBeVisible();
  await supabaseRow.getByRole('button', { name: /^revoke/i }).click();
  await expect(supabaseRow.getByText(/^locked$/)).toBeVisible();
  await expect(page.getByText(/02 locked/i).first()).toBeVisible();

  await app.close();
});

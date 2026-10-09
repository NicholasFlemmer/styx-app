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

  // The Codex lane, waiting on you, from the project nav (ADR-0027 §1).
  await page.locator('[data-nav-lane][data-lane-status="your-turn"]').first().click();
  await page.getByRole('button', { name: /^review request$/i }).click();
  const sheet = page.getByRole('dialog', { name: /supabase/i });
  await expect(sheet).toBeVisible();
  // A production write on Supabase, whose token can't be narrowed per grant: once only (issue #29).
  await expect(sheet.getByRole('radio', { name: 'once' })).toHaveAttribute('aria-checked', 'true');
  for (const d of ['1h', 'session', 'always'])
    await expect(sheet.getByRole('radio', { name: d })).toBeDisabled();
  await sheet
    .getByRole('button', { name: /^grant once · (touch id|windows hello|system password)$/i })
    .click();

  await expect(page.getByText(/grant: supabase-prod · read\+write · one command/)).toBeVisible();
  await expect(page.getByText(/01 needs you/i).first()).toBeVisible();
  await expect(page.getByText(/01 locked/i).first()).toBeVisible();

  await page.getByRole('button', { name: /^access/i }).click();
  await page.waitForSelector('[data-screen-ready="approvals"]');
  await expect(page.getByRole('tab', { name: /requests · 2/i })).toBeVisible();
  await page.getByRole('tab', { name: /audit log/i }).click();
  await expect(page.getByText(/granted read\+write to Codex · once/)).toBeVisible();

  await page.click('[data-nav-item="project:targets"]');
  await page.waitForSelector('[data-screen-ready="settings"]');
  const supabaseRow = page.getByRole('row', { name: /supabase/i }).first();
  await expect(supabaseRow.getByText(/open · (1h|\d+m) left/)).toBeVisible();
  await supabaseRow.getByRole('button', { name: /^revoke/i }).click();
  await expect(supabaseRow.getByText(/^locked$/)).toBeVisible();
  await expect(page.getByText(/02 locked/i).first()).toBeVisible();

  await app.close();
});

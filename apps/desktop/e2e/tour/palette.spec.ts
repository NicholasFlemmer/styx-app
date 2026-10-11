/**
 * Tour: one box for everything. The command palette opens over the workspace, "grant" narrows it to the waiting
 * access request, and Enter opens the request.
 */
import { test } from '@playwright/test';
import { startTour, steps } from './tour';

test('tour: the command palette', async () => {
  const t = await startTour('palette', { screen: 'workspace' });
  try {
    const { page } = t;
    await steps.workspaceReady(page);
    await steps.restPointer(page);
    await t.reach('workspace', page.locator('body'));
    await steps.openPalette(page);
    const palette = steps.palette(page);
    const input = palette.getByRole('combobox');
    await t.reach('palette-open', palette, { input, first: palette.getByRole('option').first() });
    // Letter by letter, as the list narrows.
    for (const word of ['g', 'gr', 'gra', 'gran', 'grant']) {
      await input.fill(word);
      await t.reach(`palette-${word}`, palette, { input, first: palette.getByRole('option').first() });
    }
    await page.keyboard.press('Enter');
    const sheet = page.getByRole('dialog', { name: /supabase/i });
    await t.reach('palette-result', sheet, {
      reason: sheet.getByText(/to run migration/),
      grant: sheet.getByRole('button', { name: /^grant/i }),
    });
  } finally {
    await t.close();
  }
});

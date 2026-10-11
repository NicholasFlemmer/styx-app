/** Tour: something to do while an agent works. Snake, from the palette, in the chat pane. */
import { expect, test } from '@playwright/test';
import { startTour, steps } from './tour';

test('tour: snake while you wait', async () => {
  const t = await startTour('arcade', { screen: 'workspace' });
  try {
    const { page } = t;
    await steps.workspaceReady(page);
    await page.click('[data-nav-lane][data-lane-status="working"] >> nth=0');
    await page.locator('[data-chat-pane] [data-keyscope="composer"] textarea').focus();
    await steps.openPalette(page);
    const input = page.getByRole('dialog').getByRole('combobox');
    await input.fill('play');
    await steps.restPointer(page);
    const option = page.getByRole('dialog').getByRole('option').first();
    await expect(option).toContainText('Play while you wait');
    await t.reach('palette-play', steps.palette(page), { option });
    await page.keyboard.press('Enter');
    const board = page.locator('[data-arcade="snake"]');
    await t.reach('snake-start', board);
    for (const key of ['ArrowUp', 'ArrowRight', 'ArrowDown']) {
      await page.keyboard.press(key);
      await page.waitForTimeout(450);
    }
    await t.reach('snake-moving', board);
    await t.reach('snake-pane', page.locator('[data-chat-pane]'), { board });
  } finally {
    await t.close();
  }
});

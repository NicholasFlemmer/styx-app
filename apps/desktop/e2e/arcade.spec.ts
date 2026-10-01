/**
 * Snake while you wait (owner addition, discrepancy row 110). The demo fixture's Claude session is working, so
 * the palette offers the row; the board takes the transcript's place, plays on the arrow keys, pauses when
 * focus leaves it, and Esc hands focus back to what opened it. The hold on a needs-you ask is unit-tested (it
 * needs a session to change state under the game).
 */
import { test, expect } from '@playwright/test';
import { launchStyx } from './launch';

test('palette → Play while you wait → board, keys, pause on blur, Esc back', async () => {
  const { app, page } = await launchStyx({ screen: 'workspace', fixture: 'demo', theme: 'dark' });
  await page.waitForSelector('[data-chat-pane]', { timeout: 10_000 });
  // The row exists only for the tab the person is on, and the fixture's first tab (Claude) is working.
  await page.click('[data-nav-lane][data-lane-status="working"] >> nth=0');
  const composer = page.locator('[data-chat-pane] [data-keyscope="composer"] textarea');
  await composer.focus();

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  const input = page.getByRole('dialog').getByRole('combobox');
  await input.fill('snake');
  await expect(page.getByRole('dialog').getByRole('option').first()).toContainText('Play while you wait');
  await page.keyboard.press('Enter');

  const board = page.locator('[data-arcade="snake"]');
  await expect(board).toBeVisible();
  await expect(board).toHaveAttribute('data-arcade-phase', 'ready');
  // The transcript is gone from the pane, the composer stays.
  await expect(page.locator('[data-chat-pane] [role="log"]')).toHaveCount(0);
  await expect(composer).toBeVisible();
  const frame = page.locator('[data-arcade-frame]');
  await expect(frame).toBeFocused();
  // Whole pixels per cell: 20 columns at a 16px cell in the 360px pane.
  const box = await frame.boundingBox();
  expect(box?.width).toBe(322);
  expect(box?.height).toBe(258);

  // An arrow starts it; the snake moves on its own.
  await page.keyboard.press('ArrowUp');
  await expect(board).toHaveAttribute('data-arcade-phase', 'playing');
  const headY = async () => Number(await page.locator('[data-arcade-head]').getAttribute('y'));
  const y0 = await headY();
  await expect.poll(headY, { timeout: 2_000 }).toBeLessThan(y0);

  // Space pauses; the word sits over the board and the hint says how to continue.
  await page.keyboard.press('Space');
  await expect(board).toHaveAttribute('data-arcade-phase', 'paused');
  await expect(page.locator('[data-arcade-overlay]')).toHaveText('Paused');
  await page.keyboard.press('ArrowRight');
  await expect(board).toHaveAttribute('data-arcade-phase', 'playing');

  // Clicking into the composer pauses the game: keys typed there are a message, not moves.
  await composer.click();
  await expect(board).toHaveAttribute('data-arcade-phase', 'paused');
  await expect(frame).not.toBeFocused();

  // Esc on the board quits; focus returns to the composer that opened the palette.
  await frame.click();
  await page.keyboard.press('Escape');
  await expect(board).toHaveCount(0);
  await expect(page.locator('[data-chat-pane] [role="log"]')).toHaveCount(1);
  await expect(composer).toBeFocused();

  await app.close();
});

test("the game is the pane's: another tab keeps it; a tab that needs you holds it and takes the row away", async () => {
  const { app, page } = await launchStyx({ screen: 'workspace', fixture: 'demo', theme: 'dark' });
  await page.waitForSelector('[data-chat-pane]', { timeout: 10_000 });
  await page.click('[data-nav-lane][data-lane-status="working"] >> nth=0');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await page.getByRole('dialog').getByRole('combobox').fill('snake');
  await page.keyboard.press('Enter');
  const board = page.locator('[data-arcade="snake"]');
  await expect(board).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(board).toHaveAttribute('data-arcade-phase', 'playing');

  // Gemini's tab (idle): the board stays (paused, since the click took focus off it) and plays on.
  await page.click('[data-nav-lane][data-lane-status="idle"] >> nth=0');
  await expect(board).toBeVisible();
  await expect(board).toHaveAttribute('data-arcade-phase', 'paused');
  await page.locator('[data-arcade-frame]').click();
  await page.keyboard.press('Space');
  await expect(board).toHaveAttribute('data-arcade-phase', 'playing');

  // Codex's tab needs you: the game is held under a strip, the transcript with the ask is back, and the
  // palette no longer offers the game on this tab.
  await page.click('[data-nav-lane][data-lane-status="your-turn"] >> nth=0');
  await expect(board).toHaveCount(0);
  await expect(page.locator('[data-chat-pane] [role="log"]')).toHaveCount(1);
  await expect(page.locator('[data-arcade-held]')).toHaveAttribute('data-arcade-held', 'waiting');
  await expect(page.locator('[data-arcade-held]')).toContainText('Codex needs you');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await page.getByRole('dialog').getByRole('combobox').fill('snake');
  // The game is not offered (a loose fuzzy match on another row, "Send feedback … makes Styx", may remain).
  await expect(page.getByRole('option', { name: /Play while you wait/ })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Back on Claude's (working): Resume, then the countdown, then the snake moves again.
  await page.click('[data-nav-lane][data-lane-status="working"] >> nth=0');
  await expect(page.locator('[data-arcade-held]')).toHaveAttribute('data-arcade-held', 'resumable');
  await page.click('[data-arcade-resume]');
  await expect(board).toBeVisible();
  await expect(page.locator('[data-arcade-overlay]')).toHaveAttribute('data-arcade-overlay', 'countdown');
  await expect(board).toHaveAttribute('data-arcade-phase', 'playing', { timeout: 3_000 });
  await expect(page.locator('[data-arcade-overlay]')).toHaveCount(0);

  await app.close();
});

import { test, expect } from '@playwright/test';
import { launchStyx } from './launch';

/**
 * App shell (roadmap 04-05): titlebar, nav routing, palette open/close. Runs over STYX_FIXTURE=demo; until main's
 * snapshot lands the renderer hydrates from the core demo fixture (state/sync.ts dev fallback).
 */
test('shell renders, navigates, and opens the palette', async () => {
  const { app, page } = await launchStyx({ screen: 'home' });
  // Cold boot seeds the fixture DB before the first snapshot; allow more than the 5 s default.
  // Requires preload to expose `env.screen` (STYX_SCREEN); without it the renderer opens Workspace.
  await expect(page.locator('[data-screen-ready="home"]')).toBeAttached({ timeout: 20_000 });

  const titlebar = page.getByRole('banner');
  await expect(titlebar.getByText('STYX', { exact: true })).toBeVisible();
  await expect(titlebar.getByText(/needs you/i)).toBeVisible();
  await expect(titlebar.getByText(/locked/i)).toBeVisible();

  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Agents' }).click();
  await expect(page.locator('[data-screen-ready="agents"]')).toBeAttached();

  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${mod}+KeyK`);
  const combobox = page.getByRole('combobox');
  await expect(combobox).toBeVisible();
  await expect(combobox).toBeFocused();
  await expect(page.locator('#layer-app')).toHaveAttribute('inert', '');

  await page.keyboard.press('Escape');
  await expect(combobox).toHaveCount(0);
  await expect(page.locator('#layer-app')).not.toHaveAttribute('inert', '');

  await app.close();
});

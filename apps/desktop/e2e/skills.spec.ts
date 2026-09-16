/**
 * Settings › App › Skills over the demo fixture: the three seeded skills, search, the read-first catalogue
 * (answered offline by `skills-fixture.ts`), and an install that lands in the fixture home — never the real one.
 */
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchStyx } from './launch';

const THIRD_PARTY = ['.monaco-editor', '.xterm'];

test('Skills pane lists the fixture skills, searches, reads a catalogue skill and installs it for Codex', async () => {
  const { app, page, userData } = await launchStyx({ screen: 'settings', theme: 'dark', chrome: 'mac' });
  try {
    await page.waitForSelector('[data-screen-ready="settings"]', { timeout: 10_000 });
    await page.click('[data-app-rail-item="settings"]');
    await page.click('[data-settings-nav="app:skills"]');
    const pane = page.locator('[data-skills-pane]');
    await expect(pane).toBeVisible();

    // The three seeded rows: two of the user's own (one shared) and acme-shop's committed one.
    const installed = pane.locator('[data-skills-installed] [data-skill]');
    await expect(installed).toHaveCount(3);
    await expect(installed.filter({ hasText: 'pdf' })).toContainText('You');
    await expect(installed.filter({ hasText: 'release-notes' })).toContainText('Project');
    await expect(installed.filter({ hasText: 'sql-review' })).toContainText('Shared');

    const search = page.getByRole('textbox', { name: 'Search skills' });
    await search.fill('sql');
    await expect(installed).toHaveCount(1);
    await expect(installed.first()).toContainText('sql-review');
    await search.fill('');
    await expect(installed).toHaveCount(3);

    // The catalogue loaded offline; pdf is already installed for Claude.
    const catalogue = pane.locator('[data-skills-catalogue]');
    await expect(catalogue.locator('[data-catalogue-skill]')).toHaveCount(3, { timeout: 10_000 });
    await expect(catalogue.locator('[data-catalogue-skill="pdf"]')).toContainText('Installed · Claude');
    const xlsx = catalogue.locator('[data-catalogue-skill="xlsx"]');
    await expect(xlsx).not.toContainText('Installed');

    // Read first: the drawer renders the SKILL.md, then offers the install form.
    await xlsx.getByRole('button', { name: 'Read · xlsx' }).click();
    const drawer = page.getByRole('dialog', { name: 'Skill' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('heading', { name: 'Rules' })).toBeVisible();
    await expect(drawer.getByText(/Read it before installing/)).toBeVisible();

    let builder = new AxeBuilder({ page })
      .setLegacyMode(true)
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
    for (const sel of THIRD_PARTY) builder = builder.exclude(sel);
    const withDrawer = await builder.analyze();
    expect(withDrawer.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

    // Only Codex. The Checkbox input is visually hidden under its label, so the label is the click target.
    for (const host of ['claude', 'codex', 'gemini', 'cursor']) {
      const box = drawer.locator(`[data-skill-host="${host}"]`);
      if ((await box.isChecked()) !== (host === 'codex')) {
        await drawer.locator(`label:has([data-skill-host="${host}"])`).click();
      }
      await expect(box).toBeChecked({ checked: host === 'codex' });
    }
    await drawer.getByRole('button', { name: 'Install' }).click();
    await expect(drawer).toBeHidden();

    const file = join(userData, 'fixture-home', '.codex', 'skills', 'xlsx', 'SKILL.md');
    await expect.poll(() => existsSync(file), { timeout: 10_000 }).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('name: xlsx');
    for (const other of ['.claude', '.gemini', '.cursor', '.agents'])
      expect(existsSync(join(userData, 'fixture-home', other, 'skills', 'xlsx'))).toBe(false);

    await expect(xlsx).toContainText('Installed · Codex');
    await expect(installed).toHaveCount(4);
    await expect(installed.filter({ hasText: 'xlsx' })).toContainText('Codex');
    await expect(page.getByText('Installed xlsx for Codex')).toBeVisible();

    let paneBuilder = new AxeBuilder({ page })
      .setLegacyMode(true)
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
    for (const sel of THIRD_PARTY) paneBuilder = paneBuilder.exclude(sel);
    const afterInstall = await paneBuilder.analyze();
    expect(afterInstall.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  } finally {
    await app.close();
  }
});

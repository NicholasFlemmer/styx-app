/**
 * Tour: skills. Settings › Skills lists the skills each agent already has, and a catalogue to add more (answered
 * offline in e2e); a skill is read first, then installed for the agents you pick, and the list says who has it.
 */
import { expect, test } from '@playwright/test';
import { startTour, steps } from './tour';

test('tour: skills from the catalogue', async () => {
  const t = await startTour('skills', {
    screen: 'settings',
    // acme-shop's own skill is committed in its repo, so the demo repos are on disk here.
    env: { STYX_DEMO_REPOS: '1' },
  });
  try {
    const { page } = t;
    await page.locator('[data-screen-ready="settings"]').waitFor({ state: 'attached' });
    await page.click('[data-app-rail-item="settings"]');
    await page.click('[data-settings-nav-item="app:skills"]');
    const pane = page.locator('[data-skills-pane]');
    const installed = pane.locator('[data-skills-installed]');
    const catalogue = pane.locator('[data-skills-catalogue]');
    await expect(installed.locator('[data-skill]')).toHaveCount(3);
    await expect(catalogue.locator('[data-catalogue-skill]')).toHaveCount(3);
    await steps.restPointer(page);
    const row = (name: string) => installed.locator(`[data-skill="${name}"]`);
    await t.reach('installed', installed, {
      pdf: row('pdf'),
      notes: row('release-notes'),
      sql: row('sql-review'),
    });
    const xlsx = catalogue.locator('[data-catalogue-skill="xlsx"]');
    const read = xlsx.getByRole('button', { name: 'Read · xlsx' });
    await t.reach('catalogue', catalogue, {
      pdf: catalogue.locator('[data-catalogue-skill="pdf"]'),
      xlsx,
      read,
    });

    await read.click();
    const drawer = page.getByRole('dialog', { name: 'Skill' });
    await expect(drawer.getByRole('heading', { name: 'Rules' })).toBeVisible();
    // Claude Code and Codex get it; the others don't.
    for (const host of ['claude', 'codex', 'gemini', 'cursor']) {
      const want = host === 'claude' || host === 'codex';
      const box = drawer.locator(`[data-skill-host="${host}"]`);
      if ((await box.isChecked()) !== want)
        await drawer.locator(`label:has([data-skill-host="${host}"])`).click();
      await expect(box).toBeChecked({ checked: want });
    }
    const install = drawer.getByRole('button', { name: 'Install' });
    const hosts = {
      claude: drawer.locator('label:has([data-skill-host="claude"])'),
      codex: drawer.locator('label:has([data-skill-host="codex"])'),
    };
    await steps.restPointer(page);
    await t.reach('drawer', drawer, {
      warning: drawer.locator('[data-skill-warning]'),
      ...hosts,
      install,
    });
    await steps.pressHold(page, install, () => t.reach('install-pressed', drawer, { install }));
    await install.click();
    await expect(drawer).toBeHidden();
    await expect(xlsx).toContainText('Installed', { timeout: 10_000 });
    await expect(installed.locator('[data-skill]')).toHaveCount(4);
    await steps.restPointer(page);
    await t.reach('catalogue-installed', catalogue, { xlsx });
    await t.reach('installed-after', installed, { xlsx: row('xlsx') });
  } finally {
    await t.close();
  }
});

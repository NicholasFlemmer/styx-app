/**
 * Settings › App › Agents (owner addition): the app-level agent connections page. With the demo fixture the five
 * CLIs carry their accounts; Connect on a row opens the Connect agent modal. No real CLI is signed into here (the
 * modal's open-time verify runs against fixture binaries this machine does not have, which is a no-op).
 */
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import { launchStyx } from './launch';

const READY_TIMEOUT = 10_000;
const THIRD_PARTY = ['.monaco-editor', '.xterm'];

test('Settings › Agents lists every agent with its account and opens Connect agent', async () => {
  const { app, page } = await launchStyx({
    screen: 'settings',
    fixture: 'demo',
    theme: 'dark',
    chrome: 'mac',
    env: { STYX_DEMO_REPOS: '0' },
  });
  try {
    await page.locator('[data-screen-ready]').first().waitFor({ state: 'attached', timeout: READY_TIMEOUT });
    // App sections open from the app rail (owner layout #85); Settings itself starts on the project's Targets.
    await page.click('[data-app-rail-item="settings"]');
    await page.click('[data-settings-nav-item="app:agents"]');
    await expect(page.locator('[data-settings-section="app:agents"]')).toBeVisible();

    const rows = page.locator('[data-agent-row]');
    await expect(rows).toHaveCount(5);
    await expect(rows.nth(0)).toContainText('nic@acme.dev');
    await expect(rows.nth(0)).toHaveAttribute('data-agent-state', 'connected');
    await expect(rows.nth(1)).toContainText('ChatGPT');
    await expect(rows.nth(2)).toHaveAttribute('data-agent-state', 'signed-out');
    await expect(rows.nth(3)).toContainText('nic@acme.dev');
    await expect(rows.nth(3)).toHaveAttribute('data-agent-state', 'unverified');
    await expect(rows.nth(4)).toHaveAttribute('data-agent-state', 'shell');

    await page.locator('[data-agent-row="gemini"] button', { hasText: 'Connect' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Connect Gemini CLI');
    await expect(dialog.locator('[data-cli-installed]')).toContainText('/opt/homebrew/bin/gemini');

    // Legacy mode: the default run opens a blank page via `context.newPage()`, which Electron does not support.
    let builder = new AxeBuilder({ page })
      .setLegacyMode(true)
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
    for (const sel of THIRD_PARTY) builder = builder.exclude(sel);
    const results = await builder.analyze();
    const summary = results.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 5),
    }));
    expect(summary, JSON.stringify(summary, null, 2)).toEqual([]);

    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();
  } finally {
    await app.close();
  }
});

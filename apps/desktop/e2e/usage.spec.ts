/**
 * Usage page (owner request after t3code): the by-agent and by-project tables summed from the demo fixture's
 * sessions, the limits block with its Refresh, and an axe pass. The demo CLIs name binaries this machine does not
 * have, so Refresh is a no-op here (the service only asks an installed Codex app-server); the button still
 * dispatches and settles.
 */
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import { launchStyx } from './launch';

type StyxWindow = Window & {
  styx: { command(name: string, input: unknown): Promise<{ ok: boolean; value?: unknown }> };
};

const READY_TIMEOUT = 10_000;
const THIRD_PARTY = ['.monaco-editor', '.xterm'];

test('Usage sums the demo sessions by agent and by project, shows the limits block, and is axe clean', async () => {
  const { app, page } = await launchStyx({
    screen: 'usage',
    fixture: 'demo',
    theme: 'dark',
    chrome: 'mac',
    env: { STYX_DEMO_REPOS: '0' },
  });
  try {
    await page.locator('[data-screen-ready="usage"]').waitFor({ state: 'attached', timeout: READY_TIMEOUT });
    await expect(page.locator('[data-app-rail-item="usage"]')).toHaveAttribute('data-on', 'true');
    await expect(page.getByRole('heading', { level: 2, name: 'Usage' })).toBeVisible();

    // By agent: the demo's seven agent sessions (shell left out), nothing reported → dashes, never $0.00.
    const byAgent = page.locator('[data-usage-table="agent"]');
    await expect(byAgent.getByRole('columnheader')).toHaveText([
      'Agent',
      'Sessions',
      'Turns',
      'Tokens',
      'Cost',
    ]);
    const agentRows = byAgent.locator('[data-usage-row]');
    await expect(agentRows).toHaveCount(4);
    await expect(agentRows.nth(0)).toHaveAttribute('data-usage-row', 'claude');
    await expect(agentRows.nth(0).getByRole('cell')).toHaveText(['Claude Code', '3', '0', '—', '—']);
    await expect(byAgent.locator('[data-usage-row="shell"]')).toHaveCount(0);
    await expect(byAgent.locator('[data-usage-total]').getByRole('cell')).toHaveText([
      'Total',
      '7',
      '0',
      '—',
      '—',
    ]);

    // By project: four projects carry agent sessions; acme-shop has the most.
    const byProject = page.locator('[data-usage-table="project"]');
    await expect(byProject.getByRole('columnheader').first()).toHaveText('Project');
    await expect(byProject.locator('[data-usage-row]')).toHaveCount(4);
    await expect(byProject.locator('[data-usage-row]').nth(0).getByRole('cell').nth(0)).toHaveText(
      'acme-shop',
    );
    await expect(byProject.locator('[data-usage-total]').getByRole('cell').nth(1)).toHaveText('7');

    // Limits: nothing reported yet. The demo rows name binaries this machine does not have, so Refresh finds no
    // Codex app-server to ask and the empty text stays.
    await expect(page.locator('[data-usage-empty="limits"]')).toHaveText(
      'No limits reported yet. Start a session, or refresh.',
    );
    const refresh = page.locator('[data-usage-refresh]');
    await refresh.click();
    await expect(refresh).toHaveText('Refresh');
    await expect(refresh).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('[data-usage-empty="limits"]')).toBeVisible();

    // Re-detect so the fake `codex` on PATH (e2e/fixtures/bin, an app-server) takes over; Refresh now reads its
    // `account/rateLimits/read`: plan, both windows with bars, and the report's age from the frozen clock.
    await page.evaluate(() => (window as unknown as StyxWindow).styx.command('detect.clis', {}));
    await refresh.click();
    const codex = page.locator('[data-usage-limit="codex"]');
    await expect(codex).toBeVisible({ timeout: 20_000 });
    await expect(codex.getByRole('cell').nth(0)).toHaveText('Codex');
    await expect(codex.getByRole('cell').nth(1)).toHaveText('plan team');
    const windows = codex.locator('[data-usage-window]');
    await expect(windows).toHaveCount(2);
    await expect(windows.nth(0)).toHaveText(/^5 h · 3% used · resets in /);
    await expect(windows.nth(1)).toHaveText(/^7 d · 1% used · resets in /);
    await expect(windows.nth(0).locator('[data-usage-fill]')).toHaveAttribute('style', /width: 3%/);
    await expect(codex.getByRole('cell').nth(3)).toHaveText('now');
    await expect(page.locator('[data-usage-empty="limits"]')).toHaveCount(0);
    await expect(page.locator('[data-usage-limit]')).toHaveCount(1);

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
  } finally {
    await app.close();
  }
});

/** Tour: the agents you bring. Settings lists each agent CLI, its version, the account it's signed in with and its state. */
import { test } from '@playwright/test';
import { startTour, steps } from './tour';

test('tour: the agents table', async () => {
  const t = await startTour('agents', { screen: 'home' });
  try {
    const { page } = t;
    await steps.homeReady(page);
    await page.click('[data-app-rail-item="settings"]');
    await page.click('[data-settings-nav-item="app:agents"]');
    await steps.restPointer(page);
    const table = page.getByRole('table', { name: 'Agents' });
    const row = (agent: string) => page.locator(`[data-agent-row="${agent}"]`);
    await t.reach('agents-table', table, {
      claude: row('claude'),
      codex: row('codex'),
      gemini: row('gemini'),
      cursor: row('cursor'),
      opencode: row('opencode'),
    });
    await t.reach('agents-section', page.locator('[data-settings-section="app:agents"]'));
    // Connect one more: Gemini's Connect held, then the sign-in it opens.
    const connect = row('gemini').getByRole('button', { name: /^Connect/ });
    await steps.pressHold(page, connect, () =>
      t.reach('connect-pressed', table, { gemini: row('gemini'), connect }),
    );
    await connect.click();
    const dialog = page.getByRole('dialog');
    await steps.restPointer(page);
    await t.reach('connect-dialog', dialog, {
      signIn: dialog.getByRole('button', { name: 'Sign in to Gemini' }),
    });
  } finally {
    await t.close();
  }
});

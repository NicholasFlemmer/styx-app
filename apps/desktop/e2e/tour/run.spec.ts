/**
 * Tour: run the app locally. Claude Code's lane (fix/checkout) has a `dev` script and the project knows to run it
 * with `npm run dev`; Run locally starts it in that lane, the status bar names the address, and the design pane
 * shows the running page beside the code.
 */
import { fixtures } from '@styx/core';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startTour, steps } from './tour';

type StyxWindow = Window & { styx: { command: (name: string, input: unknown) => Promise<unknown> } };

/** Off the ports other specs use (3998, 3999), so suites running side by side don't collide. */
const PORT = 3987;
const URL = `http://localhost:${PORT}`;
const PAGE = [
  '<!doctype html><html><head><title>Acme Shop</title></head>',
  '<body style="margin:0;font-family:system-ui,sans-serif;background:#f4f1ea;color:#1a1a1a">',
  '<main style="max-width:420px;margin:0 auto;padding:40px 24px">',
  '<h1 style="font-size:28px;margin:0 0 24px">Acme Shop</h1>',
  '<div style="background:#fff;border:1px solid #1a1a1a;padding:20px">',
  '<div style="display:flex;justify-content:space-between"><span>Canvas tote</span><span>$24.00</span></div>',
  '<div style="display:flex;justify-content:space-between;margin-top:8px"><span>Enamel mug</span><span>$12.00</span></div>',
  '<hr style="border:0;border-top:1px solid #ccc;margin:16px 0">',
  '<div style="display:flex;justify-content:space-between;font-weight:600"><span>Total</span><span>$36.00</span></div>',
  '<button style="width:100%;margin-top:20px;padding:14px;font-size:16px;background:#1a1a1a;color:#fff;border:0">Pay</button>',
  '</div></main></body></html>',
].join('');
// A server that answers with the page, then prints its address (a URL is adopted once something answers on it).
const SERVER = [
  "require('http')",
  `  .createServer((q, s) => { s.writeHead(200, { 'Content-Type': 'text/html' }); s.end(${JSON.stringify(PAGE)}); })`,
  `  .listen(${PORT}, () => console.log('ready ${URL}'));`,
  '',
].join('\n');

/** The design window's page: main's own view, which Playwright sees as a page of its own. */
async function previewPage(app: { windows: () => Page[] }): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(() => {
      found = app.windows().find((p) => p.url().startsWith(URL));
      return found !== undefined;
    })
    .toBe(true);
  if (!found) throw new Error('preview page not found');
  return found;
}

test('tour: run the app locally', async () => {
  // The dev server runs in the lane's real worktree, so the demo repos are on disk here.
  const t = await startTour('run', { screen: 'workspace', env: { STYX_DEMO_REPOS: '1' } });
  try {
    const { app, page } = t;
    await steps.workspaceReady(page);
    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    const lane = join(userData, 'demo-repos', '.styx', 'worktrees', 'acme-shop', 'fix-checkout');
    writeFileSync(join(lane, 'server.js'), SERVER);
    writeFileSync(
      join(lane, 'package.json'),
      `${JSON.stringify({ name: 'acme-shop', private: true, scripts: { dev: 'node server.js' } }, null, 2)}\n`,
    );
    // What the agent's first run leaves behind: the command it found, saved for the project.
    await page.evaluate(
      (projectId) =>
        (window as unknown as StyxWindow).styx.command('project.settings.set', {
          projectId,
          patch: { devCommand: 'npm run dev' },
        }),
      fixtures.ids.project.acmeShop,
    );
    await page.click('[data-workspace-mode="design"]');
    const row = page.locator('[data-run-row]');
    const start = row.locator('[data-run-start]');
    const command = row.locator('[data-run-command]');
    await expect(command).toHaveValue('npm run dev');
    await steps.restPointer(page);
    await t.reach('ready', row, { start, command });
    await steps.pressHold(page, start, () => t.reach('run-pressed', row, { start }));

    await start.click();
    const bar = page.locator('[data-status-bar]');
    await expect(bar).toContainText(`dev · ${URL}`, { timeout: 20_000 });
    await expect(page.locator('[data-run-phase]')).toHaveText(`Running · ${URL}`);
    await expect(page.getByLabel('Dev server URL')).toHaveValue(URL);
    await steps.restPointer(page);
    await t.reach('running', row, { stop: row.locator('[data-run-stop]') });
    await t.reach('run-strip', page.locator('[data-run-strip]'), { phase: page.locator('[data-run-phase]') });

    const shown = await previewPage(app);
    await t.reach('page', shown.locator('main'), {
      title: shown.getByRole('heading', { name: 'Acme Shop' }),
      pay: shown.getByRole('button', { name: 'Pay' }),
    });

    await page.click('[data-run-stop]');
    await expect(page.locator('[data-run-phase]')).toContainText('Exited', { timeout: 20_000 });
  } finally {
    await t.close();
  }
});

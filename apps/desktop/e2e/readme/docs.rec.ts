/**
 * Screenshots for the docs (heystyx.com/docs), recorded from the demo data at 1280×800 into
 * `apps/website/public/docs/img/`. `pnpm -F @styx/desktop readme:gif` re-records them with the README media.
 */
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchStyx } from '../launch';

const IMG = resolve(__dirname, '../../../website/public/docs/img');
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${IMG}/${name}`, type: 'jpeg', quality: 88 });
type StyxWindow = { styx: { command: (n: string, i: unknown) => Promise<{ ok: boolean; value: unknown }> } };

test.describe.configure({ mode: 'serial' });

test('docs: command palette', async () => {
  const { app, page } = await launchStyx({
    screen: 'workspace',
    theme: 'dark',
    chrome: 'mac',
    env: { STYX_DEMO_REPOS: '0' },
  });
  await page.waitForSelector('[data-screen-ready="workspace"]');
  await page.keyboard.press('ControlOrMeta+K');
  await page.getByRole('dialog').getByRole('combobox').waitFor();
  await page.waitForTimeout(400);
  await shot(page, 'palette.jpg');
  await app.close();
});

test('docs: the chat with a working task', async () => {
  const { app, page } = await launchStyx({
    screen: 'workspace',
    theme: 'dark',
    chrome: 'mac',
    env: { STYX_DEMO_REPOS: '0' },
  });
  await page.waitForSelector('[data-screen-ready="workspace"]');
  await page.click('[data-nav-lane][data-lane-status="working"] >> nth=0');
  await page.waitForTimeout(600);
  await shot(page, 'chat-composer.jpg');
  await app.close();
});

test('docs: Changes for a task with work', async () => {
  const { app, page } = await launchStyx({
    screen: 'workspace',
    theme: 'dark',
    chrome: 'mac',
    env: { STYX_DEMO_REPOS: '0' },
  });
  await page.waitForSelector('[data-screen-ready="workspace"]');
  await page.click('[data-nav-lane][data-lane-status="working"] >> nth=0');
  await page.click('[data-workspace-mode="changes"]');
  await page.waitForTimeout(900);
  await shot(page, 'changes.jpg');
  await app.close();
});

test('docs: the agent dock', async () => {
  const { app, page } = await launchStyx({
    screen: 'agents',
    theme: 'dark',
    chrome: 'mac',
    env: { STYX_DEMO_REPOS: '0' },
  });
  await page.evaluate(() =>
    (window as unknown as StyxWindow).styx.command('window.agentDock', { open: true }),
  );
  const dock = await app.waitForEvent('window', { timeout: 10_000 });
  await dock.waitForSelector('[data-dock]', { timeout: 10_000 });
  await dock.waitForTimeout(500);
  await shot(dock, 'agent-dock.jpg');
  await app.close();
});

test('docs: the Publish dialog with a drafted message', async () => {
  const { app, page, userData } = await launchStyx({ screen: 'repo', theme: 'dark', chrome: 'mac' });
  const repo = join(userData, 'demo-repos', 'acme-shop');
  const bare = join(userData, 'origin.git');
  execFileSync('git', ['init', '--bare', '-q', bare]);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', bare]);
  // The fake `claude` (e2e/fixtures/bin) drafts the message, so nobody's usage is spent.
  await page.evaluate(() => (window as unknown as StyxWindow).styx.command('detect.clis', {}));
  await page.locator('[data-repo]').waitFor({ timeout: 20_000 });
  await page.locator('[data-lane="test/flaky"]').getByRole('button', { name: 'Open PR' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Pull request title').waitFor();
  await expect(dialog.getByLabel('Commit message')).not.toHaveValue('', { timeout: 30_000 });
  await page.waitForTimeout(300);
  await shot(page, 'publish.jpg');
  await app.close();
});

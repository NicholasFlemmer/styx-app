/**
 * Tour: a phone app on a simulator. acme-shop looks like an Expo app here, so Run locally offers iOS; Run boots the
 * simulator and its screen shows in the Design tab, in a phone frame, with a row that names the device. The fake
 * `xcrun` in e2e/fixtures/bin stands in for Xcode (one iPhone 17 Pro); its screen is a checkout page drawn here, and
 * the run command is a local script that stays alive, so nothing is built or downloaded.
 */
import { fixtures } from '@styx/core';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startTour, steps } from './tour';

type StyxWindow = Window & { styx: { command: (name: string, input: unknown) => Promise<unknown> } };

/** The app on the simulator: a checkout page, drawn at twice the iPhone 17 Pro's point size. */
const drawScreen = async (page: Page): Promise<Buffer> => {
  const url = await page.evaluate(async () => {
    const W = 393;
    const H = 852;
    const c = document.createElement('canvas');
    c.width = W * 2;
    c.height = H * 2;
    const g = c.getContext('2d');
    if (!g) throw new Error('canvas');
    await document.fonts.ready;
    g.scale(2, 2);
    const font = (size: number, weight = 400) => `${weight} ${size}px Archivo, sans-serif`;
    g.fillStyle = '#f6f5f1';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#16161a';
    g.font = font(15, 600);
    g.fillText('acme-shop', 24, 72);
    g.font = font(30, 600);
    g.fillText('Your bag', 24, 128);
    const items: [string, string, string][] = [
      ['Canvas tote', 'Natural, one size', '$24.00'],
      ['Enamel mug', 'Forest green', '$16.00'],
      ['Field notebook', 'Dot grid, A5', '$12.00'],
    ];
    let y = 168;
    for (const [name, detail, price] of items) {
      g.fillStyle = '#dcd9cf';
      g.fillRect(24, y, 64, 64);
      g.fillStyle = '#16161a';
      g.font = font(17, 600);
      g.fillText(name, 104, y + 26);
      g.fillStyle = '#6b6a66';
      g.font = font(14);
      g.fillText(detail, 104, y + 48);
      g.fillStyle = '#16161a';
      g.font = font(17, 600);
      g.textAlign = 'right';
      g.fillText(price, W - 24, y + 26);
      g.textAlign = 'left';
      y += 88;
    }
    g.fillStyle = '#dcd9cf';
    g.fillRect(24, y, W - 48, 1);
    g.fillStyle = '#16161a';
    g.font = font(17);
    g.fillText('Total', 24, y + 40);
    g.font = font(17, 600);
    g.textAlign = 'right';
    g.fillText('$52.00', W - 24, y + 40);
    g.fillStyle = '#16161a';
    g.fillRect(24, H - 128, W - 48, 56);
    g.fillStyle = '#f6f5f1';
    g.textAlign = 'center';
    g.font = font(18, 600);
    g.fillText('Pay $52.00', W / 2, H - 93);
    return c.toDataURL('image/png');
  });
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
};

test.skip(process.platform !== 'darwin', 'the iOS simulator runs only on a Mac');

test('tour: run it on a phone simulator', async () => {
  const sim = mkdtempSync(join(tmpdir(), 'styx-fake-sim-'));
  const screen = join(sim, 'screen.png');
  const t = await startTour('devices', {
    screen: 'workspace',
    env: { STYX_DEMO_REPOS: '1', STYX_FAKE_SIM_DIR: sim, STYX_FAKE_SIM_SCREEN: screen },
  });
  try {
    const { app, page } = t;
    // The seeded acme-shop checkout made to look like an Expo app, so Run locally offers the device platforms.
    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    const repo = join(userData, 'demo-repos', '.styx', 'worktrees', 'acme-shop', 'fix-checkout');
    const keepAlive = `node -e "console.log('Metro waiting on exp://127.0.0.1:8081');setInterval(()=>{},1000)"`;
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify(
        { name: 'acme-shop', private: true, scripts: { ios: keepAlive }, dependencies: { expo: '^54.0.0' } },
        null,
        2,
      ),
    );
    writeFileSync(join(repo, 'app.json'), JSON.stringify({ expo: { name: 'acme-shop', slug: 'acme-shop' } }));
    await steps.workspaceReady(page);
    writeFileSync(screen, await drawScreen(page));
    await page.evaluate(
      (projectId) =>
        (window as unknown as StyxWindow).styx.command('project.settings.set', {
          projectId,
          patch: { devCommand: 'npm run ios', devPlatform: 'ios' },
        }),
      fixtures.ids.project.acmeShop,
    );
    await steps.foldTerminal(page);
    await page.click('[data-workspace-mode="design"]');

    const row = page.locator('[data-run-row]');
    const ios = row.locator('[data-run-platforms]').getByRole('radio', { name: 'iOS' });
    await expect(ios).toHaveAttribute('aria-checked', 'true', { timeout: 10_000 });
    const run = row.locator('[data-run-start]');
    const pane = row.locator('..');
    const hole = page.locator('[data-preview-hole]');
    const phone = hole.locator('[data-preview-frame-kind]');
    const status = page.locator('[data-device-row]');
    await steps.restPointer(page);
    const runParts = {
      run,
      ios,
      device: row.locator('[data-device-pick]'),
      command: row.locator('[data-run-command]'),
    };
    await t.reach('run-row', row, runParts);
    await t.reach('pane-idle', pane, runParts);
    await steps.pressHold(page, run, () => t.reach('run-pressed', row, { run }));
    await run.click();

    await expect(page.locator('[data-device-phase="booting"]')).toBeVisible({ timeout: 10_000 });
    await steps.restPointer(page);
    await t.reach('booting', pane, { status, phone });
    await expect(page.locator('[data-device-phase="ready"]')).toBeVisible({ timeout: 20_000 });
    // The run's output folds away; the phone is the point.
    const toggle = page.locator('[data-run-toggle]');
    if ((await toggle.getAttribute('aria-expanded')) === 'true') await toggle.click();
    const image = hole.locator('[data-device-frame][data-mirror="screenshots"] img');
    await expect
      .poll(() => image.evaluate((img) => (img as HTMLImageElement).naturalWidth), { timeout: 10_000 })
      .toBe(786);
    await steps.restPointer(page);
    await t.reach('mirror', pane, { status, phone });
    await t.reach('phone', phone);
    await expect(page.locator('[data-status-bar]')).toContainText(/ios · iPhone 17 Pro/i);
  } finally {
    await t.close();
  }
});

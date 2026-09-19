/**
 * The design window as a simulator (owner request): a "Run locally" on a device platform boots the simulator
 * first, the pane shows it booting and then mirrors its screen, the status bar names the device, and Stop ends
 * it. This Mac has no Xcode or Android SDK: the fake `xcrun` / `open` / `adb` / `emulator` in e2e/fixtures/bin
 * stand in (one `iPhone 17 Pro`, FAKE-17PRO, whose state lives under STYX_FAKE_SIM_DIR), so what is exercised is
 * everything from the click to the pixels except the real simulator. Screen Recording is never granted to the
 * test binary, so the mirror is the screenshots fallback: frames come from `simctl io … screenshot` (the fake
 * writes a real 393×852 PNG) and reach the pane over `styx-device://frame/<project>?seq=n`.
 */
import { fixtures } from '@styx/core';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { launchStyx } from './launch';

/** The seeded acme-shop repo made to look like an Expo app, so `run.detect` offers the device platforms. */
const seedExpoApp = (userData: string) => {
  const repo = join(userData, 'demo-repos', '.styx', 'worktrees', 'acme-shop', 'fix-checkout');
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'acme-shop', private: true, dependencies: { expo: '^54.0.0' } }, null, 2),
  );
  writeFileSync(join(repo, 'app.json'), JSON.stringify({ expo: { name: 'acme-shop', slug: 'acme-shop' } }));
};

test('a device run boots the simulator, mirrors it into the design window by screenshots, and Stop ends it', async () => {
  const simDir = mkdtempSync(join(tmpdir(), 'styx-fake-sim-'));
  const { app, page, userData } = await launchStyx({
    screen: 'workspace',
    fixture: 'demo',
    theme: 'dark',
    env: { STYX_FAKE_SIM_DIR: simDir },
  });
  // The harness materialises the demo repos under userData at boot; the app's files are written after that.
  seedExpoApp(userData);
  await page.waitForSelector('[data-workspace-mode="design"]', { timeout: 10_000 });

  // What the agent's `remember_command` ends up doing for a mobile app: a command that builds and launches it on
  // the iOS simulator. The command here only has to stay alive; the fake simulator shows its own picture.
  await page.evaluate(
    (projectId) =>
      (
        window as unknown as { styx: { command: (name: string, input: unknown) => Promise<unknown> } }
      ).styx.command('project.settings.set', {
        projectId,
        patch: { devCommand: 'node -e "setInterval(()=>{},1000)"', devPlatform: 'ios' },
      }),
    fixtures.ids.project.acmeShop,
  );
  await page.click('[data-workspace-mode="design"]');

  // The platform the project remembers is the one pressed.
  const ios = page.locator('[data-run-platforms]').getByRole('radio', { name: 'iOS' });
  await expect(ios).toBeVisible({ timeout: 10_000 });
  await expect(ios).toHaveAttribute('aria-checked', 'true');

  await page.click('[data-run-start]');
  // The row appears as soon as the boot starts (the fake bootstatus takes 1.5 s), then goes ready.
  await expect(page.locator('[data-device-phase="booting"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-device-phase="ready"]')).toBeVisible({ timeout: 20_000 });

  // Screenshots mode: an <img> fed from the privileged scheme, decoding to the simulator's own size.
  const frame = page.locator('[data-device-frame][data-mirror="screenshots"] img');
  await expect(frame).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => frame.getAttribute('src'), { timeout: 10_000 }).toMatch(/^styx-device:\/\/frame\//);
  await expect
    .poll(() => frame.evaluate((img) => (img as HTMLImageElement).naturalWidth), { timeout: 10_000 })
    .toBe(393);
  // Frames keep coming: the seq in the URL moves on.
  const seqOf = async () => Number(/seq=(\d+)/.exec((await frame.getAttribute('src')) ?? '')?.[1] ?? 0);
  const first = await seqOf();
  await expect.poll(seqOf, { timeout: 10_000 }).toBeGreaterThan(first);

  const bar = page.locator('[data-status-bar]');
  await expect(bar).toContainText(/ios · iPhone 17 Pro/i, { timeout: 10_000 });

  await page.click('[data-device-stop]');
  await expect(page.locator('[data-device-phase]')).toHaveCount(0, { timeout: 10_000 });
  await expect(bar).not.toContainText(/iPhone 17 Pro/);
  // The simulator and the run are independent (Metro may outlive the device and the other way round): stopping
  // the simulator leaves the command running, so the run is stopped on its own before the pane is back at Run.
  await page.click('[data-run-stop]');
  await expect(page.locator('[data-run-start]')).toBeVisible({ timeout: 20_000 });

  await app.close();
});

/**
 * The same path without the pane: what main does for `run.start` on iOS — tooling on the (shadowed) PATH, boot,
 * the screenshots fallback, frames over `styx-device://` that the renderer's CSP lets an <img> decode — checked
 * through the command bridge alone, so it holds whatever the pane looks like.
 */
test('run.start on ios boots the simulator in main and serves its frames over styx-device://', async () => {
  const simDir = mkdtempSync(join(tmpdir(), 'styx-fake-sim-'));
  const { app, page } = await launchStyx({
    screen: 'workspace',
    fixture: 'demo',
    theme: 'dark',
    env: { STYX_FAKE_SIM_DIR: simDir },
  });
  await page.waitForSelector('[data-workspace-mode="design"]', { timeout: 10_000 });
  const projectId = fixtures.ids.project.acmeShop;
  type Result = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };
  const command = (name: string, input: unknown) =>
    page.evaluate(
      ([n, i]) =>
        (
          window as unknown as { styx: { command: (name: string, input: unknown) => Promise<Result> } }
        ).styx.command(n as string, i),
      [name, input] as const,
    );

  const tooling = await command('device.tooling', {});
  expect(tooling).toMatchObject({ ok: true, value: { ios: true, android: false, iosInput: false } });
  const list = await command('device.list', { platform: 'ios' });
  expect(list).toMatchObject({
    ok: true,
    value: { devices: [{ id: 'FAKE-17PRO', name: 'iPhone 17 Pro', state: 'shutdown' }] },
  });

  // Boots (the fake bootstatus takes 1.5 s), then starts the command; the run row carries the platform, no URL.
  const started = await command('run.start', {
    projectId,
    command: 'node -e "setInterval(()=>{},1000)"',
    platform: 'ios',
  });
  expect(started).toMatchObject({ ok: true });
  expect(await command('device.list', { platform: 'ios' })).toMatchObject({
    ok: true,
    value: { devices: [{ id: 'FAKE-17PRO', state: 'booted' }] },
  });

  // No Screen Recording for the test binary and no Simulator window: screenshots, with the reason.
  const mirror = await command('device.mirror', { projectId });
  expect(mirror).toMatchObject({ ok: true, value: { mode: 'screenshots' } });

  // A frame is readable from the privileged scheme and decodes at the simulator's size.
  const width = async () =>
    page.evaluate(
      (src) =>
        new Promise<number>((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img.naturalWidth);
          img.onerror = () => resolve(-1);
          img.src = src;
        }),
      `styx-device://frame/${projectId}?seq=${Date.now()}`,
    );
  await expect.poll(width, { timeout: 10_000 }).toBe(393);

  // Stop forgets the device and, asked to, shuts the simulator down (the fake's marker goes: it lists as shut down).
  expect(await command('device.stop', { projectId, shutdown: true })).toEqual({ ok: true, value: {} });
  expect(await command('device.mirror', { projectId })).toMatchObject({ ok: true, value: { mode: 'none' } });
  expect(await command('device.list', { platform: 'ios' })).toMatchObject({
    ok: true,
    value: { devices: [{ id: 'FAKE-17PRO', state: 'shutdown' }] },
  });
  expect(await width()).toBe(-1);
  await command('run.stop', { projectId });

  await app.close();
});

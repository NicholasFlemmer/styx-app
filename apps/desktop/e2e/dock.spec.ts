/**
 * The agent dock: a third window kind beside the main shell and pop-out chat. It carries no state of its own —
 * the read model was already global and `boardColumns` already cross-project — so what matters here is that the
 * window opens, shows agents from more than one project, and routes a click back into main.
 */
import { test, expect } from '@playwright/test';
import { launchStyx } from './launch';

/** A wait in ms, tripled on CI, where opening a window is far slower than on a dev machine. */
const slow = (ms: number): number => (process.env['CI'] ? ms * 3 : ms);

test('opens a cross-project dock whose cards focus the main window', async () => {
  const { app, page } = await launchStyx({
    screen: 'agents',
    fixture: 'demo',
    theme: 'dark',
    platform: 'darwin',
  });

  // Listen before asking: the window can open before the command's reply arrives.
  const opened = app.waitForEvent('window', { timeout: slow(10_000) });
  await page.evaluate(async () => {
    await (
      window as never as { styx: { command: (n: string, i: unknown) => Promise<unknown> } }
    ).styx.command('window.agentDock', { open: true });
  });

  const dock = await opened;
  await dock.waitForSelector('[data-dock]', { timeout: slow(10_000) });

  // Always on top: that is the whole point of a dock.
  const onTop = await app.evaluate(async ({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((w) => w.isAlwaysOnTop()),
  );
  expect(onTop).toBe(true);

  const cards = dock.locator('[data-dock-card]');
  await expect.poll(async () => cards.count(), { timeout: 5000 }).toBeGreaterThan(0);

  // Cross-project: the demo fixture spans more than one project, and the dock filters by none of them.
  const projects = await dock.locator('[data-dock-card]').evaluateAll((els) =>
    els.map((el) => el.getAttribute('aria-label') ?? ''),
  );
  expect(new Set(projects.map((p) => p.split(' in ')[1])).size).toBeGreaterThan(1);

  // A card routes into main rather than opening a chat in the dock.
  await cards.first().click();
  await expect.poll(async () => page.locator('[data-chat-pane]').count(), { timeout: 5000 }).toBe(1);

  await app.close();
});

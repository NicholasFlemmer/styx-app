/**
 * Select to fix in the running app (#140): Preview's Select to fix hands the page a pick; a click on an element there
 * comes back named, with a picture, and the note goes to the lane's agent with a chip naming what was pointed at.
 */
import { createServer, type Server } from 'node:http';
import { test, expect } from '@playwright/test';
import { launchStyx } from './launch';

let PORT = 0;
let server: Server;

test.beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<html><head><title>Shop</title></head><body style="margin:0;font:16px system-ui"><h1>Checkout</h1><button id="pay" style="position:absolute;left:40px;top:120px;width:200px;height:40px">Pay €70</button></body></html>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  PORT = typeof addr === 'object' && addr !== null ? addr.port : 0;
});
test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('Select to fix: click the broken thing in the app, tell the agent, the message names it', async () => {
  const { app, page } = await launchStyx({ screen: 'workspace' });
  try {
    await page.waitForSelector('[data-workspace-mode="design"]', { timeout: 20_000 });
    await page.click('[data-workspace-mode="design"]');
    const field = page.getByLabel('Dev server URL');
    await field.fill(`localhost:${PORT}`);
    await field.press('Enter');
    const loaded = () =>
      app.evaluate(({ webContents }, port: number) => {
        const w = webContents.getAllWebContents().find((x) => x.getURL().includes(String(port)));
        return w?.getTitle() ?? null;
      }, PORT);
    await expect.poll(loaded, { timeout: 15_000 }).toBe('Shop');

    const pick = page.locator('[data-preview-pick]');
    await expect(pick).toBeEnabled();
    await pick.click();
    await expect(pick).toHaveAttribute('data-preview-pick', 'picking');
    // The page draws the pick layer; click the button in it (view coordinates, at the page's zoom).
    await expect
      .poll(
        () =>
          app.evaluate(async ({ webContents }, port: number) => {
            const w = webContents.getAllWebContents().find((x) => x.getURL().includes(String(port)));
            return (await w?.executeJavaScript('!!document.querySelector("[data-styx-pick]")')) ?? false;
          }, PORT),
        { timeout: 5_000 },
      )
      .toBe(true);
    await app.evaluate(async ({ webContents }, port: number) => {
      const w = webContents.getAllWebContents().find((x) => x.getURL().includes(String(port)));
      if (w === undefined) return;
      const z = w.getZoomFactor();
      const x = Math.round(140 * z);
      const y = Math.round(140 * z);
      w.sendInputEvent({ type: 'mouseMove', x, y });
      w.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      w.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    }, PORT);

    const strip = page.locator('[data-preview-fix]');
    await expect(strip).toBeVisible({ timeout: 10_000 });
    await expect(strip).toContainText('button#pay “Pay €70”');
    await strip.locator('[data-preview-fix-text]').fill('Say Pay now');
    await strip.locator('[data-preview-fix-send]').click();
    await expect(strip).toHaveCount(0);
    await expect(page.locator('[data-chat-pane] [data-message-pointer]').last()).toContainText('button#pay', {
      timeout: 10_000,
    });
  } finally {
    await app.close();
  }
});

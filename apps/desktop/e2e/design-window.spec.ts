/**
 * The design window renders the running app in a native WebContentsView, so nothing about it is visible to the
 * renderer DOM — it can only be checked through the Electron app itself. The overlay rule matters most: a native
 * view paints above the DOM, so it must leave the screen whenever a modal, the palette or a sheet is open.
 */
import { createServer, type Server } from 'node:http';
import { test, expect } from '@playwright/test';
import { launchStyx } from './launch';

// An ephemeral port, not a fixed one: a fixed port made this fail inside the full suite (still held by a
// previous run) while passing on its own.
let PORT = 0;
let server: Server;

test.beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><head><title>Dev Server</title></head><body>STYX PREVIEW OK</body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  PORT = typeof addr === 'object' && addr !== null ? addr.port : 0;
});
test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('renders the dev server, emulates a device, and leaves the screen for overlays', async () => {
  const { app, page } = await launchStyx({
    screen: 'workspace',
    fixture: 'demo',
    theme: 'dark',
    platform: 'darwin',
  });
  await page.waitForSelector('[data-workspace-mode="design"]', { timeout: 10_000 });
  await page.click('[data-workspace-mode="design"]');
  const field = page.getByLabel('Dev server URL');
  await field.fill(`localhost:${PORT}`);
  await field.press('Enter');

  const view = async () =>
    app.evaluate(async ({ webContents }, port: number) => {
      const w = webContents.getAllWebContents().find((x) => x.getURL().includes(String(port)));
      return w === undefined ? null : { title: w.getTitle(), url: w.getURL() };
    }, PORT);

  await expect.poll(view, { timeout: 10_000 }).not.toBeNull();
  expect((await view())?.title).toBe('Dev Server');

  const body = await app.evaluate(async ({ webContents }, port: number) => {
    const w = webContents.getAllWebContents().find((x) => x.getURL().includes(String(port)));
    return w === undefined ? null : await w.executeJavaScript('document.body.innerText');
  }, PORT);
  expect(body).toContain('STYX PREVIEW OK');

  // A device preset emulates a viewport rather than resizing the pane.
  await page.click('[data-preview-device="phone"]');
  await expect
    .poll(
      async () =>
        app.evaluate(async ({ webContents }, port: number) => {
          const w = webContents.getAllWebContents().find((x) => x.getURL().includes(String(port)));
          return w === undefined ? 0 : await w.executeJavaScript('window.innerWidth');
        }, PORT),
      { timeout: 5000 },
    )
    .toBe(393);

  // The palette is a DOM overlay: the native view must go off screen or it would cover it.
  const bounds = async () =>
    app.evaluate(async ({ BaseWindow }) => {
      const win = BaseWindow.getAllWindows()[0];
      const child = win?.contentView.children.at(-1);
      const b = child?.getBounds();
      return b ? b.width * b.height : -1;
    });
  expect(await bounds()).toBeGreaterThan(0);
  await page.keyboard.press('Meta+K');
  await expect.poll(bounds, { timeout: 5000 }).toBe(-1);

  await app.close();
});
